/*
 * Secrets — at-rest sealing for provider api keys (and tool
 * credentials) with a versioned env keyring.
 *
 * Business logic:
 * - keys come from PROVIDER_KEY_ENC_KEYS as `v1:<b64>,v2:<b64>`;
 *   every listed version can decrypt, and new values are sealed with
 *   PROVIDER_KEY_ENC_ACTIVE or, when unset, the last-listed (newest)
 *   key — rotation is "append a key, run `pnpm keys:rekey`", which
 *   rewrites whatever needsRekey flags (sealed with a non-active
 *   version, or still plaintext).
 * - sealed values are `enc:<version>:<base64(iv | tag | ciphertext)>`
 *   under aes-256-gcm; a stored value that doesn't match the
 *   envelope predates encryption and passes through untouched, so
 *   switching encryption on (or off again) needs no migration or
 *   downtime.
 * - a malformed keyring is fatal at parse time: silently storing
 *   plaintext when encryption was intended is worse than refusing to
 *   boot. a missing version, truncated payload or wrong key throws
 *   `[secrets] …` on decrypt, which catalog.ts escalates to a config
 *   error instead of a dead-upstream warning.
 * - encryption is opt-in: with the env unset everything is stored as
 *   plaintext and a warning is logged once per process; the parsed
 *   keyring is cached on globalThis so dev-server HMR neither
 *   re-reads the env nor re-logs.
 * - callers seal writes with encryptSecret (providers and
 *   tool-credentials routes), and the only outbound reads — catalog
 *   fetchers, chat completions in runs.ts/complete.ts — open with
 *   decryptSecret, so a stored key is never sent upstream raw.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/* provider api keys are sealed as `enc:<version>:<base64(iv | tag | ciphertext)>`.
   a stored value that doesn't match predates encryption and passes through as-is,
   which is what makes switching encryption on (or off again) non-breaking. */
const ENVELOPE = /^enc:([A-Za-z0-9_-]{1,32}):([A-Za-z0-9+/=]+)$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEYS_ENV = 'PROVIDER_KEY_ENC_KEYS';
const ACTIVE_ENV = 'PROVIDER_KEY_ENC_ACTIVE';
const GENERATE_HINT = `generate one with: openssl rand -base64 32`;

type Keyring = {
  /* version → 32-byte aes-256 key; every listed version can decrypt */
  keys: Map<string, Buffer>;
  /* version new values are sealed with; null when encryption is off */
  active: string | null;
};

/* cached on globalThis so dev-server HMR neither re-reads the env nor re-logs per reload */
const g = globalThis as typeof globalThis & { __keyring?: Keyring };

/** parses `v1:<b64>,v2:<b64>`; a malformed keyring is fatal, since silently storing
    plaintext when encryption was intended is worse than refusing to boot */
const parseKeyring = (): Keyring => {
  const raw = process.env[KEYS_ENV]?.trim();
  if (!raw) return { keys: new Map(), active: null };

  const keys = new Map<string, Buffer>();
  for (const part of raw.split(',')) {
    const entry = part.trim();
    if (!entry) continue;
    const sep = entry.indexOf(':');
    const version = sep < 0 ? '' : entry.slice(0, sep).trim();
    const secret = sep < 0 ? '' : entry.slice(sep + 1).trim();
    if (!version || !secret)
      throw new Error(
        `[secrets] ${KEYS_ENV} expects "version:base64-32-byte-key" pairs, got "${entry}"`,
      );
    if (keys.has(version))
      throw new Error(`[secrets] ${KEYS_ENV} lists version "${version}" twice`);
    const key = Buffer.from(secret, 'base64');
    if (key.length !== 32)
      throw new Error(
        `[secrets] ${KEYS_ENV} version "${version}" must decode to 32 bytes, got ${key.length}; ${GENERATE_HINT}`,
      );
    keys.set(version, key);
  }

  const versions = [...keys.keys()];
  if (!versions.length) return { keys, active: null };
  /* newest key is listed last, so leaving ACTIVE unset encrypts with that */
  const active =
    process.env[ACTIVE_ENV]?.trim() || versions[versions.length - 1];
  if (!active || !keys.has(active))
    throw new Error(
      `[secrets] ${ACTIVE_ENV}="${active}" is not in ${KEYS_ENV} (known: ${versions.join(', ')})`,
    );
  return { keys, active };
};

const keyring = (): Keyring => {
  if (!g.__keyring) g.__keyring = parseKeyring();
  return g.__keyring;
};

/* logged on first import, i.e. once per process; the guard lives on globalThis for HMR */
const logStatus = () => {
  const { keys, active } = keyring();
  if (!active) {
    console.warn(
      `[secrets] ${KEYS_ENV} is not set — provider api keys are stored in plaintext. ${GENERATE_HINT}, then set ${KEYS_ENV}=v1:<key> and run \`pnpm keys:rekey\`.`,
    );
    return;
  }
  console.log(
    `[secrets] provider api keys encrypted: writing "${active}", decryptable: ${[...keys.keys()].join(', ')}`,
  );
};

logStatus();

/** false when no keyring is configured, i.e. values are stored in plaintext */
export const encryptionEnabled = () => keyring().active !== null;

/**
 * seals a plaintext value for storage. null passes through, and with no keyring
 * configured the value is stored as-is (with a warning already logged at boot).
 */
export const encryptSecret = (plain: string | null): string | null => {
  const { keys, active } = keyring();
  if (!plain || !active) return plain;
  const key = keys.get(active);
  if (!key) throw new Error(`[secrets] active version "${active}" has no key`);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  return `enc:${active}:${payload.toString('base64')}`;
};

/** opens a stored value; a legacy plaintext row is returned untouched */
export const decryptSecret = (stored: string | null): string | null => {
  if (!stored) return stored;
  const match = ENVELOPE.exec(stored);
  if (!match) return stored;
  const version = match[1] ?? '';
  const key = keyring().keys.get(version);
  if (!key)
    throw new Error(
      `[secrets] value is sealed with version "${version}", which is missing from ${KEYS_ENV}`,
    );
  const buf = Buffer.from(match[2] ?? '', 'base64');
  if (buf.length < IV_BYTES + TAG_BYTES)
    throw new Error(`[secrets] value sealed with "${version}" is truncated`);
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      buf.subarray(0, IV_BYTES),
    );
    decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([
      decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    /* gcm final() throws on a tampered value or a key that isn't the one that sealed it */
    throw new Error(
      `[secrets] value sealed with "${version}" failed to decrypt: wrong key or corrupted data`,
    );
  }
};

/** the version a stored value is sealed with; null for plaintext rows */
export const secretVersion = (stored: string | null): string | null => {
  if (!stored) return null;
  return ENVELOPE.exec(stored)?.[1] ?? null;
};

/** true when a stored value isn't sealed with the active key, so rekey should rewrite it */
export const needsRekey = (stored: string | null): boolean => {
  const { active } = keyring();
  if (!stored || !active) return false;
  return secretVersion(stored) !== active;
};

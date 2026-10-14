/*
 * tool-credentials — where model-driven tools get their API keys.
 *
 * Business logic:
 * - PROVIDER_KEYS is the source of truth for every tool provider that
 *   needs a key (tavily, serper.dev, serpapi, exa, scrape.do, searxng,
 *   github). Each may name an env var; one without `env` can only ever be
 *   backed by a user-supplied key.
 * - A provider's key can come from two places: an environment variable
 *   shared per the site's envKeyAccess policy, or a per-user secret in
 *   tool_credentials. envKeysShared folds that policy plus the caller's
 *   admin flag into whether the env keys are usable by this user.
 * - providerKeyStates builds the settings-UI list: the `env` var name is
 *   revealed only to admins (they set it) and only when actually set, and
 *   envShared marks that the asking user may lean on the env key.
 * - envKeyValue treats an unset/blank variable as absent, not as "".
 * - User keys are sealed with encryptSecret before write and the DTO only
 *   ever exposes hasApiKey, so a stored secret never travels to a client.
 * - saveCredential upserts on (userId, provider): null clears the key,
 *   undefined means "keep what's stored" (returns the existing row or
 *   throws when there is none), and a string is encrypted and stored.
 * - parseCredentialInput rejects unknown providers and normalizes a blank
 *   key to null; deleteCredential reports whether a row was removed.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db';
import { type ToolCredentialRow, toolCredentials } from '../db/schema';
import type {
  ToolCredential,
  ToolCredentialInput,
  ToolProviderKey,
} from '../types';
import { ValidationError } from './errors';
import { encryptSecret } from './secrets';
import { getSiteSettings } from './settings';

/**
 * every API key a model-driven tool needs, keyed by provider id. a provider listed
 * here can be backed by an environment variable (shared per the site's env-key policy)
 * and/or a user-supplied key stored in `tool_credentials`.
 */
export type ProviderKeyDef = {
  /* provider id the tools expose in their `providers` list */
  id: string;
  /* ui label */
  label: string;
  /* env var name; unset means env-only is not possible for this provider */
  env?: string | undefined;
};

const PROVIDER_KEYS: ProviderKeyDef[] = [
  { id: 'tavily', label: 'Tavily', env: 'TAVILY_API_KEY' },
  { id: 'serper.dev', label: 'Serper.dev', env: 'SERPER_API_KEY' },
  { id: 'serpapi', label: 'SerpAPI', env: 'SERPAPI_API_KEY' },
  { id: 'exa', label: 'Exa', env: 'EXA_API_KEY' },
  { id: 'scrape.do', label: 'Scrape.do', env: 'SCRAPEDO_API_KEY' },
  { id: 'searxng', label: 'SearXNG', env: 'SEARXNG_URL' },
  { id: 'github', label: 'GitHub', env: 'GITHUB_PAT' },
];

export const providerKeyDefs = (): ProviderKeyDef[] => PROVIDER_KEYS;

export const providerKeyFor = (id: string): ProviderKeyDef | undefined =>
  PROVIDER_KEYS.find((p) => p.id === id);

/** the environment-defined key for a provider, or undefined when unset/blank */
export const envKeyValue = (env: string | undefined): string | undefined => {
  if (!env) return undefined;
  const value = process.env[env]?.trim();
  return value ? value : undefined;
};

/** whether the env-defined keys are usable by this user under the site's env-key policy */
export const envKeysShared = async (admin: boolean): Promise<boolean> => {
  const { envKeyAccess } = await getSiteSettings();
  return envKeyAccess === 'all' || (envKeyAccess === 'admins' && admin);
};

/**
 * the provider list for the settings ui. `env` names the variable behind a provider, but
 * only for admins — they're the ones who set it — and only when it's actually set.
 * `envShared` says the asking user may use that env key, so they need no key of their own.
 */
export const providerKeyStates = async (
  admin: boolean,
): Promise<ToolProviderKey[]> => {
  const shared = await envKeysShared(admin);
  return PROVIDER_KEYS.flatMap(({ id, label, env }) => {
    const base: ToolProviderKey = { id, label };
    if (!env || !envKeyValue(env)) return [base];
    return [
      {
        ...base,
        ...(admin ? { env } : {}),
        ...(shared ? { envShared: true } : {}),
      },
    ];
  });
};

const wherePk = (userId: string, provider: string) =>
  and(
    eq(toolCredentials.userId, userId),
    eq(toolCredentials.provider, provider),
  );

export const toCredentialDto = (row: ToolCredentialRow): ToolCredential => ({
  provider: row.provider,
  hasApiKey: !!row.apiKey,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

export const listCredentials = async (
  userId: string,
): Promise<ToolCredential[]> => {
  const rows = await getDb()
    .select()
    .from(toolCredentials)
    .where(eq(toolCredentials.userId, userId));
  return rows.map(toCredentialDto);
};

export const parseCredentialInput = (body: unknown): ToolCredentialInput => {
  const b = (body ?? {}) as Record<string, unknown>;
  const provider = typeof b.provider === 'string' ? b.provider.trim() : '';
  if (!providerKeyFor(provider))
    throw new ValidationError(`unknown provider: ${provider}`);
  if (
    b.apiKey !== undefined &&
    b.apiKey !== null &&
    typeof b.apiKey !== 'string'
  )
    throw new ValidationError('apiKey must be a string');
  const apiKey =
    typeof b.apiKey === 'string' ? b.apiKey.trim() || null : b.apiKey;
  return { provider, ...(apiKey !== undefined ? { apiKey } : {}) };
};

export const saveCredential = async (
  userId: string,
  input: ToolCredentialInput,
): Promise<ToolCredential> => {
  const db = getDb();
  if (input.apiKey === undefined) {
    const [existing] = await db
      .select()
      .from(toolCredentials)
      .where(wherePk(userId, input.provider));
    if (existing) return toCredentialDto(existing);
    throw new ValidationError('no stored key to keep');
  }
  const stored =
    input.apiKey === null ? null : encryptSecret(input.apiKey);
  const [row] = await db
    .insert(toolCredentials)
    .values({ userId, provider: input.provider, apiKey: stored })
    .onConflictDoUpdate({
      target: [toolCredentials.userId, toolCredentials.provider],
      set: { apiKey: stored },
    })
    .returning();
  if (!row) throw new Error('insert failed');
  return toCredentialDto(row);
};

export const deleteCredential = async (
  userId: string,
  provider: string,
): Promise<boolean> => {
  const result = await getDb()
    .delete(toolCredentials)
    .where(wherePk(userId, provider))
    .returning({ provider: toolCredentials.provider });
  return result.length > 0;
};

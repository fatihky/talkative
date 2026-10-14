/* re-seals provider api keys and tool credential keys with the active key version, so an
   old key can be retired. also encrypts rows written before encryption was switched on.

   usage:
     pnpm keys:rekey              rewrite every row not on the active version
     pnpm keys:rekey --dry-run    report what would change, touch nothing
     pnpm keys:rekey --decrypt    open every sealed row back to plaintext
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, gt, isNotNull, or } from 'drizzle-orm';
import pg from 'pg';
import { providerConnections, toolCredentials } from '../src/db/schema.ts';
import {
  decryptSecret,
  encryptionEnabled,
  encryptSecret,
  needsRekey,
  secretVersion,
} from '../src/server/secrets.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const decryptAll = args.includes('--decrypt');
const unknown = args.filter((a) => a !== '--dry-run' && a !== '--decrypt');
if (unknown.length) {
  console.error(`unknown argument: ${unknown[0]}`);
  console.error('usage: keys:rekey [--dry-run | --decrypt]');
  process.exit(1);
}

if (!encryptionEnabled() && !decryptAll) {
  console.error(
    'PROVIDER_KEY_ENC_KEYS is not set, so there is no active version to rekey to.',
  );
  process.exit(1);
}
if (decryptAll)
  console.warn(
    'WARNING: --decrypt writes api keys back to the database in plaintext.',
  );

const BATCH = 200;
const pool = new pg.Pool({ connectionString: url, max: 1 });
const db = drizzle(pool);

/* row counts per version after the run, so the old version can be confirmed empty */
const seen = new Map<string, number>();
const tally = (version: string | null) => {
  const label = version ?? 'plaintext';
  seen.set(label, (seen.get(label) ?? 0) + 1);
};

let scanned = 0;
let rewritten = 0;
let failed = 0;
let lastId = 0;

try {
  for (;;) {
    const rows = await db
      .select({
        id: providerConnections.id,
        apiKey: providerConnections.apiKey,
      })
      .from(providerConnections)
      .where(
        and(
          gt(providerConnections.id, lastId),
          isNotNull(providerConnections.apiKey),
        ),
      )
      .orderBy(providerConnections.id)
      .limit(BATCH);
    if (!rows.length) break;

    for (const row of rows) {
      lastId = row.id;
      scanned++;
      const before = secretVersion(row.apiKey);
      if (!decryptAll && !needsRekey(row.apiKey)) {
        tally(before);
        continue;
      }
      try {
        const plain = decryptSecret(row.apiKey);
        const next = decryptAll ? plain : encryptSecret(plain);
        if (next === row.apiKey) {
          tally(before);
          continue;
        }
        if (!dryRun)
          await db
            .update(providerConnections)
            .set({ apiKey: next })
            .where(eq(providerConnections.id, row.id));
        rewritten++;
        tally(secretVersion(next));
      } catch (e) {
        failed++;
        console.error(
          `  connection ${row.id}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (rows.length < BATCH) break;
  }

  /* tool_credentials is keyed by (user_id, provider), so paging uses the composite
     key rather than a single id column. */
  let lastUser = '';
  let lastProvider = '';
  for (;;) {
    const rows = await db
      .select({
        userId: toolCredentials.userId,
        provider: toolCredentials.provider,
        apiKey: toolCredentials.apiKey,
      })
      .from(toolCredentials)
      .where(
        and(
          isNotNull(toolCredentials.apiKey),
          or(
            gt(toolCredentials.userId, lastUser),
            and(
              eq(toolCredentials.userId, lastUser),
              gt(toolCredentials.provider, lastProvider),
            ),
          ),
        ),
      )
      .orderBy(toolCredentials.userId, toolCredentials.provider)
      .limit(BATCH);
    if (!rows.length) break;

    for (const row of rows) {
      lastUser = row.userId;
      lastProvider = row.provider;
      scanned++;
      const before = secretVersion(row.apiKey);
      if (!decryptAll && !needsRekey(row.apiKey)) {
        tally(before);
        continue;
      }
      try {
        const plain = decryptSecret(row.apiKey);
        const next = decryptAll ? plain : encryptSecret(plain);
        if (next === row.apiKey) {
          tally(before);
          continue;
        }
        if (!dryRun)
          await db
            .update(toolCredentials)
            .set({ apiKey: next })
            .where(
              and(
                eq(toolCredentials.userId, row.userId),
                eq(toolCredentials.provider, row.provider),
              ),
            );
        rewritten++;
        tally(secretVersion(next));
      } catch (e) {
        failed++;
        console.error(
          `  tool credential ${row.userId}/${row.provider}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    if (rows.length < BATCH) break;
  }
} catch (err) {
  console.error('rekey failed:');
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}

const summary = [...seen.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([version, n]) => `${version}: ${n}`)
  .join(', ');

console.log(
  `${dryRun ? '[dry-run] ' : ''}${rewritten} of ${scanned} key(s) ${
    decryptAll ? 'decrypted' : 'rekeyed'
  }${summary ? ` — now ${summary}` : ''}${failed ? `, ${failed} failed` : ''}`,
);
if (failed) process.exitCode = 1;

/*
 * migrate — the standalone `pnpm db:migrate` runner.
 *
 * Business logic:
 * - A top-level-await script (not imported by the app) that applies the
 *   Drizzle SQL migrations in ./drizzle against DATABASE_URL.
 * - Loads .env via process.loadEnvFile() but tolerates its absence, since
 *   in a container the vars come from the environment; a missing
 *   DATABASE_URL is fatal (exit 1) before anything connects.
 * - ensureDatabase first connects to the `postgres` admin DB and creates
 *   the target database when it's absent, making a fresh-instance first
 *   run idempotent instead of failing on "database does not exist".
 * - Logs a redacted connection URL (credentials regexed out) so the run is
 *   traceable without leaking the secret.
 * - Migrates over a single-connection pool (max:1), prints success, and on
 *   failure logs the error plus err.cause and sets exitCode=1; the pool is
 *   always closed in `finally`.
 */
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

try {
  process.loadEnvFile();
} catch {
  /* no .env in the container; env vars come from the environment */
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const redacted = url.replace(/\/\/[^@]*@/, '//***:***@');
console.log(`connecting to ${redacted}`);

const ensureDatabase = async () => {
  const parsed = new URL(url);
  const dbName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!dbName) return;

  const adminUrl = new URL(url);
  adminUrl.pathname = '/postgres';

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query(
      'select 1 from pg_database where datname = $1',
      [dbName],
    );
    if (!rowCount) {
      console.log(`database "${dbName}" does not exist, creating it`);
      await admin.query(`create database ${pg.escapeIdentifier(dbName)}`);
    }
  } finally {
    await admin.end();
  }
};

const pool = new pg.Pool({ connectionString: url, max: 1 });

try {
  await ensureDatabase();
  const db = drizzle(pool);
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('migrations applied successfully');
} catch (err) {
  console.error('migration failed:');
  console.error(err);
  if (err instanceof Error && err.cause) {
    console.error('caused by:');
    console.error(err.cause);
  }
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}

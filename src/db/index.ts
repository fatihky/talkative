/*
 * db — the process's single Postgres/Drizzle handle.
 *
 * Business logic:
 * - getDb memoizes one Drizzle instance (built on a pg.Pool pointed at
 *   DATABASE_URL, wired with the full schema for the relational query API)
 *   on globalThis, so dev-server HMR reloads reuse a single pool instead
 *   of opening a new one per reload — the app's single-instance posture.
 * - The pool is created lazily on first getDb() call; the module also
 *   exports a ready-made `db = getDb()` at import time because better-auth's
 *   Drizzle adapter wants an instance, not a lazy getter.
 * - `Db` is exported as the instance type so server functions can be typed
 *   against it without importing Drizzle internals.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

/* cached on globalThis so dev-server HMR doesn't open a new pool per reload */
const g = globalThis as typeof globalThis & {
  __db?: ReturnType<typeof drizzle<typeof schema>>;
};

export const getDb = () => {
  if (!g.__db) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    g.__db = drizzle(pool, { schema });
    /* start the model-catalog sweeper once the pool exists; dynamic import avoids
       the catalog -> db -> catalog cycle */
    if (process.env.CATALOG_REFRESH_MS !== '0') {
      import('../server/catalog').then((m) => m.startCatalogSweeper());
    }
  }
  return g.__db;
};

export type Db = ReturnType<typeof getDb>;

/* better-auth's drizzle adapter expects a ready-made instance */
export const db = getDb();


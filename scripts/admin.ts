/* admin — the only way to grant or revoke admin rights outside the UI's user
   management: the bootstrap path that makes the first admin (or repairs one),
   matching users by email or id.

   usage:
     pnpm admin:grant <email|id>
     pnpm admin:revoke <email|id>
*/

import { eq, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { user } from '../src/db/schema.ts';

try {
  process.loadEnvFile();
} catch {
  // no .env in the container; env vars come from the environment
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const [action, identifier] = process.argv.slice(2);

if ((action !== 'grant' && action !== 'revoke') || !identifier) {
  console.error('usage: admin <grant|revoke> <email|id>');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url, max: 1 });
const db = drizzle(pool);

try {
  const [row] = await db
    .update(user)
    .set({ isAdmin: action === 'grant' })
    .where(
      or(eq(user.email, identifier.toLowerCase()), eq(user.id, identifier)),
    )
    .returning({ email: user.email, isAdmin: user.isAdmin });

  if (!row) {
    console.error(`no user found matching "${identifier}"`);
    process.exitCode = 1;
  } else {
    console.log(
      `${row.email} is now ${row.isAdmin ? 'an admin' : 'no longer an admin'}`,
    );
  }
} catch (err) {
  console.error('failed:');
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}

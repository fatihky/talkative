/* drops the uploads nothing points at any more: attachment rows no message references
   (a file taken back out of the composer, a chat deleted before pruning ran) and files
   left on disk whose row is gone (deleting a user cascades their rows away).

   usage:
     pnpm uploads:gc                 remove uploads orphaned for over a day
     pnpm uploads:gc --days 7        require a longer orphan period before removing
     pnpm uploads:gc --dry-run       report what would go, touch nothing
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq, gt, sql } from 'drizzle-orm';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { attachments, messages } from '../src/db/schema.ts';
import { deleteUpload, listUploads, uploadsDir } from '../src/server/uploads.ts';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const daysAt = args.indexOf('--days');
const rawDays = daysAt === -1 ? '1' : (args[daysAt + 1] ?? '');
const days = rawDays.trim() === '' ? Number.NaN : Number(rawDays);
if (!Number.isFinite(days) || days < 0) {
  console.error('--days takes a number of days, 0 or more');
  process.exit(1);
}
const unknown = args.filter(
  (a, i) =>
    a !== '--dry-run' && a !== '--days' && !(daysAt !== -1 && i === daysAt + 1),
);
if (unknown.length) {
  console.error(`unknown argument: ${unknown[0]}`);
  console.error('usage: uploads:gc [--days N] [--dry-run]');
  process.exit(1);
}

/* anything written inside this window may still sit in an unsent draft */
const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

const BATCH = 200;
const pool = new pg.Pool({ connectionString: url, max: 1 });
const db = drizzle(pool);

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

let scanned = 0;
let droppedRows = 0;
let droppedFiles = 0;
let failed = 0;

try {
  /* every upload id some message still carries, so an id shared with a surviving branch
     (an edit or a resend reuses the same id) is never collected */
  const referenced = new Set<string>();
  let lastMessage = '';
  for (;;) {
    const rows = await db
      .select({
        id: messages.id,
        refs: sql<string[]>`array(select elem->>'id' from jsonb_array_elements(${messages.attachments}) as elem where elem->>'kind' in ('file', 'image'))`,
      })
      .from(messages)
      .where(gt(messages.id, lastMessage))
      .orderBy(messages.id)
      .limit(BATCH);
    if (!rows.length) break;
    for (const row of rows) {
      lastMessage = row.id;
      for (const ref of row.refs ?? []) if (ref) referenced.add(ref);
    }
    if (rows.length < BATCH) break;
  }

  /* rows past the cutoff that nothing references: the row goes, and the image file with it.
     `kept` is what still has a row afterwards, so the file pass below doesn't repeat it. */
  const kept = new Set<string>();
  let lastId = '';
  for (;;) {
    const rows = await db
      .select({
        id: attachments.id,
        userId: attachments.userId,
        name: attachments.name,
        createdAt: attachments.createdAt,
      })
      .from(attachments)
      .where(gt(attachments.id, lastId))
      .orderBy(attachments.id)
      .limit(BATCH);
    if (!rows.length) break;
    for (const row of rows) {
      lastId = row.id;
      scanned++;
      kept.add(row.id);
      if (referenced.has(row.id) || row.createdAt > cutoff) continue;
      droppedRows++;
      console.log(
        `  ${dryRun ? 'would drop' : 'dropped'} attachment ${row.name} (${row.id}, orphaned since ${row.createdAt.toISOString()})`,
      );
      if (dryRun) continue;
      try {
        await db.delete(attachments).where(eq(attachments.id, row.id));
        await deleteUpload(row.userId, row.id);
        kept.delete(row.id);
      } catch (e) {
        failed++;
        console.error(`  attachment ${row.id}: ${errorText(e)}`);
      }
    }
    if (rows.length < BATCH) break;
  }

  /* files with no row: an upload interrupted before its insert, or a deleted user's
     leftovers. mtime keeps a concurrent upload (file first, row second) out of it. */
  for (const file of await listUploads()) {
    if (kept.has(file.id)) continue;
    const p = path.join(uploadsDir(), file.userId, file.id);
    const written = await stat(p)
      .then((s) => s.mtime)
      .catch(() => null);
    if (!written || written > cutoff) continue;
    droppedFiles++;
    console.log(
      `  ${dryRun ? 'would drop' : 'dropped'} file ${file.userId}/${file.id} (no row, written ${written.toISOString()})`,
    );
    if (dryRun) continue;
    try {
      await deleteUpload(file.userId, file.id);
    } catch (e) {
      failed++;
      console.error(`  file ${file.userId}/${file.id}: ${errorText(e)}`);
    }
  }
} catch (err) {
  console.error('gc failed:');
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}

console.log(
  `${dryRun ? '[dry-run] ' : ''}${droppedRows + droppedFiles} of ${scanned} attachment(s) removed — ${droppedRows} row(s), ${droppedFiles} stray file(s), orphaned over ${days} day(s)${failed ? `, ${failed} failed` : ''}`,
);
if (failed) process.exitCode = 1;

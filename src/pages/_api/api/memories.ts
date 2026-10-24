/*
 * memories — GET/POST/DELETE /api/memories — the settings UI over the
 * per-user key/value store the `memory` tool reads and writes.
 *
 * Business logic:
 * - auth via handle() (401 without a session); all three verbs filter
 *   by userId, so this route can only ever see or wipe the caller's own
 *   memories. No admin path — memories are per-user by definition.
 * - GET lists them most recently touched first (updatedAt desc), the
 *   same order the memory tool's `list` returns, so the UI and the
 *   model agree on what's newest. No limit; the table is bounded by
 *   what a user and their models choose to remember.
 * - POST is parseMemoryCreate: key and value are both required,
 *   trimmed and non-empty, and the key is capped at 255 chars — the
 *   same trimming the tool applies, so a key typed here and one the
 *   model saved match instead of forking into two memories.
 * - keys are unique per user and this route does not upsert: an
 *   existing (userId, key) is a 400 naming the key. The tool's save
 *   does overwrite, deliberately — the UI shouldn't be able to clobber
 *   a fact silently. Two users may hold the same key, since the
 *   uniqueness check is scoped by userId.
 * - DELETE on the collection is "forget everything": it wipes the
 *   caller's rows and answers 204 even when there was nothing to
 *   delete, so the settings button is idempotent.
 * - nothing here injects memories into a prompt — a model sees them
 *   only by calling the memory tool — so no run, message or upload
 *   side effect has to be kept in sync. A vanished insert throws → 500;
 *   201 with the dto on success.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../../db';
import { memories } from '../../../db/schema';
import { parseMemoryCreate, toMemoryDto } from '../../../server/memories';
import { handle, ValidationError } from '../../../server/providers';

/* GET /api/memories — most recently touched first, like the tool's list */
export const GET = () =>
  handle(async (userId) => {
    const rows = await getDb()
      .select()
      .from(memories)
      .where(eq(memories.userId, userId))
      .orderBy(desc(memories.updatedAt));
    return Response.json(rows.map(toMemoryDto));
  });

export const POST = (req: Request) =>
  handle(async (userId) => {
    const input = parseMemoryCreate(await req.json());
    const db = getDb();
    const [result] = await db
      .select({ count: sql<number>`count(*)` })
      .from(memories)
      .where(and(eq(memories.userId, userId), eq(memories.key, input.key)));
    if (Number(result?.count ?? 0) > 0)
      throw new ValidationError(`a memory named "${input.key}" already exists`);
    const [row] = await db
      .insert(memories)
      .values({ ...input, userId })
      .returning();
    if (!row) throw new Error('insert failed');
    return Response.json(toMemoryDto(row), { status: 201 });
  });

/* DELETE /api/memories — forget everything */
export const DELETE = () =>
  handle(async (userId) => {
    await getDb().delete(memories).where(eq(memories.userId, userId));
    return new Response(null, { status: 204 });
  });

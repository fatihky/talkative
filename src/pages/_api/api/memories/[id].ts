/*
 * memories/[id] — PATCH/DELETE /api/memories/:id — edit or forget one
 * memory.
 *
 * Business logic:
 * - auth via handle(); uuid guard, then a (id, userId) lookup, so a
 *   missing or foreign memory answers memoryNotFound() 404 — never
 *   403, no existence leak.
 * - PATCH is parseMemoryPatch: key and/or value, each trimmed and
 *   non-empty when present, undefined = leave as is. A malformed field
 *   is a 400; a body with neither leaves nothing to set, which the
 *   update rejects as a 500 rather than a 400.
 * - the per-user key uniqueness re-check runs only when the key
 *   actually changes, so re-saving a memory under its own name isn't a
 *   conflict, while colliding with another of the caller's memories is
 *   a 400 naming the key. The check is scoped by userId: the same key
 *   may exist for someone else.
 * - unlike the tool's save, this is an update of one row by id, not an
 *   upsert by key — the UI edits the memory it's looking at, and the
 *   key is just a field on it.
 * - the update bumps updatedAt, which is what the collection GET orders
 *   by and what the memory tool reports as recently touched, so an edit
 *   here reshuffles the model's view of the store on its next `list`.
 * - DELETE folds ownership into its WHERE clause and reads an empty
 *   result as the same 404; on success it's 204 with no body. Memories
 *   aren't referenced by messages (a note attachment would be), so
 *   nothing cascades and no pruneAttachments()-style cleanup applies —
 *   the fact simply stops being listed. A lost write race throws → 500.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { ApiContext } from 'waku/router';
import { getDb } from '../../../../db';
import { memories } from '../../../../db/schema';
import { isUuid } from '../../../../server/chats';
import {
  memoryNotFound,
  parseMemoryPatch,
  toMemoryDto,
} from '../../../../server/memories';
import { handle, ValidationError } from '../../../../server/providers';

type Ctx = ApiContext<'/api/memories/[id]'>;

/* PATCH /api/memories/:id — key and/or value */
export const PATCH = (req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return memoryNotFound();
    const patch = parseMemoryPatch(await req.json());
    const db = getDb();
    const [row] = await db
      .select()
      .from(memories)
      .where(and(eq(memories.id, params.id), eq(memories.userId, userId)))
      .limit(1);
    if (!row) return memoryNotFound();
    if (patch.key !== undefined && patch.key !== row.key) {
      const [result] = await db
        .select({ count: sql<number>`count(*)` })
        .from(memories)
        .where(and(eq(memories.userId, userId), eq(memories.key, patch.key)));
      if (Number(result?.count ?? 0) > 0)
        throw new ValidationError(
          `a memory named "${patch.key}" already exists`,
        );
    }
    const [updated] = await db
      .update(memories)
      .set(patch)
      .where(eq(memories.id, row.id))
      .returning();
    if (!updated) throw new Error('update failed');
    return Response.json(toMemoryDto(updated));
  });

export const DELETE = (_req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return memoryNotFound();
    const result = await getDb()
      .delete(memories)
      .where(and(eq(memories.id, params.id), eq(memories.userId, userId)))
      .returning({ id: memories.id });
    return result.length > 0
      ? new Response(null, { status: 204 })
      : memoryNotFound();
  });

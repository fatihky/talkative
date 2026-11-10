/*
 * memory-revisions — GET /api/memory-revisions — the changelog of the
 * caller's memories.
 *
 * Business logic:
 * - auth via handle(); rows are filtered by userId, so only the caller's
 *   history is visible.
 * - newest first, capped at 200 rows; `?key=<key>` narrows to one fact.
 * - revisions outlive the memory they describe (memoryId is not a foreign
 *   key), so deleted facts keep their history and can be recovered by hand.
 */
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../../db';
import { memoryRevisions } from '../../../db/schema';
import { toMemoryRevisionDto } from '../../../server/memories';
import { handle } from '../../../server/providers';

export const GET = (req: Request) =>
  handle(async (userId) => {
    const key = new URL(req.url).searchParams.get('key');
    const rows = await getDb()
      .select()
      .from(memoryRevisions)
      .where(
        key
          ? and(eq(memoryRevisions.userId, userId), eq(memoryRevisions.key, key))
          : eq(memoryRevisions.userId, userId),
      )
      .orderBy(desc(memoryRevisions.createdAt))
      .limit(200);
    return Response.json(rows.map(toMemoryRevisionDto));
  });

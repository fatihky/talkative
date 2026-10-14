/*
 * chats — GET /api/chats — the sidebar's chat list.
 *
 * Business logic:
 * - auth via handle() (401 without a session); scoped by userId and
 *   capped at the newest 500 rows, so the list is bounded no matter
 *   how much history a user has.
 * - ordered by createdAt desc, not updatedAt (7e8bd98): renaming,
 *   moving, pinning or classifying a chat must not reshuffle the
 *   sidebar under the reader, and a reply landing must not reorder it
 *   either. Pinning and folder nesting are the client's job
 *   (chat-list.tsx) — pinnedAt ships in the dto but deliberately
 *   doesn't affect this ORDER BY.
 * - toChatDto only, no messages: the list carries the counters and
 *   labels the sidebar renders (branchCount, messageCount, costUsd,
 *   category/tags, folderId, systemPrompt, firstPrompt). The thread
 *   itself comes from GET /api/chats/:id.
 * - there is no POST on purpose: a chat's id is client-minted and its
 *   row is inserted by the first send (POST /api/chats/:id/messages),
 *   so the client can navigate to /c/<id> before the server answers.
 * - read-only, so no side effects to keep in sync; deletion and its
 *   upload pruning live in /api/chats/:id.
 */
import { desc, eq } from 'drizzle-orm';
import { getDb } from '../../../db';
import { chats } from '../../../db/schema';
import { toChatDto } from '../../../server/chats';
import { handle } from '../../../server/providers';

/* GET /api/chats — newest first (by creation time) */
export const GET = () =>
  handle(async (userId) => {
    const rows = await getDb()
      .select()
      .from(chats)
      .where(eq(chats.userId, userId))
      .orderBy(desc(chats.createdAt))
      .limit(500);
    return Response.json(rows.map(toChatDto));
  });

/*
 * suggestions — GET /api/suggestions — the home screen's starter
 * prompts.
 *
 * Business logic:
 * - Session-only via `handle`; the three most recently updated chats
 *   are selected for the caller alone (userId-scoped), so a suggestion
 *   can never quote somebody else's conversation.
 * - Thin wrapper over server/suggestions' buildSuggestions: pinned
 *   prompts first, then up to three recent chats (label clipped to 26
 *   chars, prompt falling back to the title when firstPrompt is empty,
 *   id prefixed `s-r-` to stay distinct), then the static set — capped
 *   at eight, so a fresh, chatless account still gets suggestions.
 * - Read-only, no query params: the ordering (chats by updatedAt desc),
 *   the limit of 3 and the cap of 8 are fixed here and in the service.
 * - Errors map through `handle` (401 with no session, 500 on a db
 *   failure); the client treats a failure as "no suggestions".
 */
import { desc, eq } from 'drizzle-orm';
import { getDb } from '../../../db';
import { chats } from '../../../db/schema';
import { handle } from '../../../server/providers';
import { buildSuggestions } from '../../../server/suggestions';

/* GET /api/suggestions — pinned + recent-chat + static suggestions for the home screen */
export const GET = () =>
  handle(async (userId) => {
    const recent = await getDb()
      .select({
        id: chats.id,
        title: chats.title,
        firstPrompt: chats.firstPrompt,
      })
      .from(chats)
      .where(eq(chats.userId, userId))
      .orderBy(desc(chats.updatedAt))
      .limit(3);
    return Response.json(buildSuggestions(recent));
  });

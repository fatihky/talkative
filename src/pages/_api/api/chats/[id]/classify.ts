/*
 * chats/[id]/classify — POST /api/chats/:id/classify — ask a model to
 * label the chat, and store the labels.
 *
 * Business logic:
 * - auth via handle(); uuid guard plus findChat(id, userId), so a
 *   missing or foreign chat is a 404. Not admin-gated — everyone
 *   classifies their own chats, with their own provider.
 * - delegates to classifyChat() (server/classify.ts): the caller's
 *   first enabled model answers with one JSON object, from which a
 *   category and at most four short lowercase tags survive; anything
 *   malformed is dropped field by field rather than failing.
 * - best-effort by design (297fd48): no enabled provider, an
 *   unparseable model id, a missing connection or a thrown model error
 *   is logged as a warning and treated as `{}` — never a 4xx/5xx.
 *   Labelling is cosmetic, so it must not be able to fail the caller,
 *   which fires this right after the first send and doesn't block on
 *   it (stores/send.ts).
 * - persistence is deliberately partial: only the fields that came
 *   back are written, and nothing is written when neither did, so an
 *   empty result leaves stored labels intact instead of wiping them.
 *   The write isn't `.returning()`ed — the response is the
 *   classification, not the chat row.
 * - always 200 with `{category?, tags?}`; the client patches its own
 *   store and then PATCHes /api/chats/:id with the same labels, so the
 *   response is the classification rather than the chat row. Nothing
 *   else to keep in sync: no runs, no uploads, no cascades — just the
 *   two chats columns.
 */
import { eq } from 'drizzle-orm';
import type { ApiContext } from 'waku/router';
import { getDb } from '../../../../../db';
import { chats } from '../../../../../db/schema';
import { chatNotFound, findChat, isUuid } from '../../../../../server/chats';
import { classifyChat } from '../../../../../server/classify';
import { handle } from '../../../../../server/providers';

type Ctx = ApiContext<'/api/chats/[id]/classify'>;

/*
 * POST /api/chats/:id/classify — asks a configured model for the chat's category/tags
 * and stores them. returns the classification (possibly empty). best-effort: a missing
 * provider or a model error yields no labels rather than failing the request.
 */
export const POST = (_req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return chatNotFound();
    const db = getDb();
    const chat = await findChat(db, userId, params.id);
    if (!chat) return chatNotFound();
    let result: { category?: string; tags?: string[] } = {};
    try {
      result = await classifyChat(userId, chat);
    } catch (e) {
      console.warn(`[classify] ${params.id} failed:`, e);
    }
    if (result.category !== undefined || result.tags !== undefined) {
      await db
        .update(chats)
        .set({
          ...(result.category !== undefined
            ? { category: result.category }
            : {}),
          ...(result.tags !== undefined ? { tags: result.tags } : {}),
        })
        .where(eq(chats.id, chat.id));
    }
    return Response.json(result);
  });

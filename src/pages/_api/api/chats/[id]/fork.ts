/*
 * chats/[id]/fork — POST /api/chats/:id/fork — copy a branch into a new chat.
 *
 * Business logic:
 * - auth via handle() (401 without a session); a non-uuid :id or a chat
 *   that isn't the caller's reads as chatNotFound() — a 404, never 403.
 * - the body carries `uptoId`, the message the fork stops at (the
 *   assistant turn whose bubble's Fork button was pressed). It must be
 *   a uuid and a message of this chat, else 400 — never a pointer into
 *   someone else's tree.
 * - forkChat() copies only the root-to-uptoId path: the chat's other
 *   branches stay behind, every copied turn gets a fresh id, and the new
 *   chat is titled "copy of <old title>" with its leaf on the copy of
 *   uptoId. The original chat is untouched; uploads are shared by
 *   reference, so pruning one chat leaves the other's files alone.
 * - 409 while hasActiveRun(chat.id): a reply still streaming would be
 *   copied half-written, and the original is about to change underneath
 *   the copy. The client hides Fork while busy for the same reason.
 * - 201 with the same ChatDetail shape GET /api/chats/:id returns, so
 *   the client can seed the new thread and navigate to it without a
 *   refetch.
 */
import type { ApiContext } from 'waku/router';
import { getDb } from '../../../../../db';
import {
  chatNotFound,
  findChat,
  forkChat,
  isUuid,
} from '../../../../../server/chats';
import { handle, ValidationError } from '../../../../../server/providers';
import { hasActiveRun } from '../../../../../server/runs';

type Ctx = ApiContext<'/api/chats/[id]/fork'>;

/* POST /api/chats/:id/fork — a new chat holding the branch that ends at `uptoId` */
export const POST = (req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return chatNotFound();
    const body = (await req.json().catch(() => ({}))) as {
      uptoId?: unknown;
    };
    const db = getDb();
    const chat = await findChat(db, userId, params.id);
    if (!chat) return chatNotFound();
    if (typeof body.uptoId !== 'string' || !isUuid(body.uptoId))
      throw new ValidationError('uptoId must be a message id');
    if (hasActiveRun(chat.id))
      return Response.json(
        { error: 'a reply is still generating in this chat' },
        { status: 409 },
      );
    const forked = await forkChat(db, chat, body.uptoId);
    if (!forked)
      throw new ValidationError('uptoId must be a message in this chat');
    return Response.json(forked, { status: 201 });
  });

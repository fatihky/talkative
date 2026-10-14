/*
 * chats/[id] — GET/PATCH/DELETE /api/chats/:id — one chat: its whole
 * message tree, its editable metadata, or its removal.
 *
 * Business logic:
 * - auth via handle() (401 without a session); all three verbs reject
 *   a non-uuid :id with chatNotFound() and findChat() matches
 *   (id, userId), so a foreign chat is a 404 too — never 403, no
 *   existence leak. Not admin-gated: chats are strictly per-user.
 * - GET returns the chat dto plus every message on every branch in
 *   createdAt order, unpaged: the client builds the sibling map from
 *   the full tree and renders only the active path.
 * - GET also repairs state before serializing — each row goes through
 *   settleOrphan(), which flips a still-'streaming' message with no
 *   live run to 'interrupted'. Such a row belongs to a previous server
 *   process and nothing will ever finish it, so without this the
 *   thread would spin forever after a restart.
 * - the returned leafId is walked down to the newest tip with
 *   newestLeafId() (2af2a93), falling back chat.leafId → last inserted
 *   message → null, so reopening a chat lands on its most recent
 *   branch rather than on a stale leaf.
 * - PATCH is parseChatPatch's whitelist: title (non-empty), category
 *   (string|null), tags (string[]), pinned → pinnedAt now/null,
 *   folderId (uuid|null), leafId, systemPrompt (≤20k chars, blank
 *   clears). Unknown fields are dropped, a malformed one is a 400, and
 *   an empty body leaves nothing to set — which the update rejects as
 *   a 500, not a 400.
 * - two cross-reference checks keep PATCH honest, and both answer 400
 *   (not 404) because the chat itself was found: folderId must be one
 *   of the caller's folders ('folder not found'), and leafId must be a
 *   message of this chat — that's the branch switch, and it must never
 *   point into someone else's tree.
 * - DELETE is the destructive path and its order matters: read the
 *   messages' stored attachment ids first, stopChatRuns() to abort any
 *   in-flight generation (a live run flushes into its row every second
 *   and would resurrect rows that are gone), delete the chat — its
 *   messages cascade in postgres — then hand those ids to
 *   pruneAttachments().
 * - pruneAttachments() is the side effect that must stay in sync:
 *   messages reference uploads by id inside their jsonb, so nothing
 *   cascades to the attachments table or to the image files on disk.
 *   It drops a row and its file only once no surviving message of this
 *   user references the id, because an edit or a resend reuses ids
 *   across branches (f208d09). `pnpm uploads:gc` collects leftovers.
 * - DELETE answers 204 with no body; a lost write race on PATCH throws
 *   → 500 'internal error'.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { ApiContext } from 'waku/router';
import { getDb } from '../../../../db';
import { chats, folders, messages } from '../../../../db/schema';
import {
  pruneAttachments,
  storedAttachmentIds,
} from '../../../../server/attachments';
import {
  chatNotFound,
  findChat,
  isUuid,
  newestLeafId,
  parseChatPatch,
  toChatDto,
  toMessageDto,
} from '../../../../server/chats';
import { handle, ValidationError } from '../../../../server/providers';
import { settleOrphan, stopChatRuns } from '../../../../server/runs';
import type { ChatDetail } from '../../../../types';

type Ctx = ApiContext<'/api/chats/[id]'>;

/* GET /api/chats/:id — the chat plus every message on every branch */
export const GET = (_req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return chatNotFound();
    const db = getDb();
    const chat = await findChat(db, userId, params.id);
    if (!chat) return chatNotFound();
    const msgs = await db
      .select()
      .from(messages)
      .where(eq(messages.chatId, chat.id))
      .orderBy(messages.createdAt);
    for (const m of msgs) await settleOrphan(db, m);
    const body: ChatDetail = {
      chat: toChatDto(chat),
      messages: msgs.map(toMessageDto),
      leafId: newestLeafId(msgs, chat.leafId ?? msgs.at(-1)?.id ?? null),
    };
    return Response.json(body);
  });

/* PATCH /api/chats/:id — rename, move between folders, store classification, set the system prompt, or switch branch */
export const PATCH = (req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return chatNotFound();
    const patch = parseChatPatch(await req.json());
    const db = getDb();
    const chat = await findChat(db, userId, params.id);
    if (!chat) return chatNotFound();
    if (patch.folderId) {
      const [folderResult] = await db
        .select({ count: sql<number>`count(*)` })
        .from(folders)
        .where(and(eq(folders.id, patch.folderId), eq(folders.userId, userId)));
      if (Number(folderResult?.count ?? 0) === 0)
        throw new ValidationError('folder not found');
    }
    if (patch.leafId) {
      const [leafResult] = await db
        .select({ count: sql<number>`count(*)` })
        .from(messages)
        .where(
          and(eq(messages.id, patch.leafId), eq(messages.chatId, chat.id)),
        );
      if (Number(leafResult?.count ?? 0) === 0)
        throw new ValidationError('leafId must be a message in this chat');
    }
    const set: Record<string, unknown> = { ...patch };
    const [updated] = await db
      .update(chats)
      .set(set)
      .where(eq(chats.id, chat.id))
      .returning();
    if (!updated) throw new Error('update failed');
    return Response.json(toChatDto(updated));
  });

/* DELETE /api/chats/:id — the chat, every message on every branch, and their uploads */
export const DELETE = (_req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return chatNotFound();
    const db = getDb();
    const chat = await findChat(db, userId, params.id);
    if (!chat) return chatNotFound();
    const msgs = await db
      .select({ attachments: messages.attachments })
      .from(messages)
      .where(eq(messages.chatId, chat.id));
    stopChatRuns(chat.id);
    await db.delete(chats).where(eq(chats.id, chat.id));
    /* the chat's messages cascade away, so their uploads go with them */
    await pruneAttachments(userId, storedAttachmentIds(msgs));
    return new Response(null, { status: 204 });
  });
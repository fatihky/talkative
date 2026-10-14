/*
 * MessageDelete — DELETE /api/messages/:id — remove a message and
 * everything that follows it in the tree.
 *
 * Business logic:
 * - auth via handle() (401 without a session); :id must be a uuid and
 *   findMessage() scopes by userId, so a missing or foreign message
 *   reads as 404 — never 403, no existence leak.
 * - refused with 409 while hasActiveRun(chatId): a live generation
 *   flushes into its row every second, so deleting underneath it would
 *   resurrect a gone message; the client must POST …/stop first.
 * - removalSet() computes the deletion closure — the target plus every
 *   descendant across all sibling branches below it — so no orphaned
 *   subtree survives (b4fc687).
 * - the removed turns' stored attachment ids go to pruneAttachments(),
 *   which drops the uploads row and file only once no surviving
 *   message of this user still references the id; edits and resends
 *   reuse ids across branches, so nothing cascades on its own
 *   (f208d09). `pnpm uploads:gc` collects any leftovers.
 * - if the chat's leafId was inside the removed set it moves to the
 *   newest remaining sibling's tip (newestLeaf), else falls back to
 *   the deleted root's parent — a chat must never point at a gone row.
 * - messageCount/branchCount are recomputed from the survivors
 *   (branchCount floors at 1) and the updated chat DTO is returned so
 *   the client re-renders without a refetch.
 * - impossible states (chat vanished mid-request, update matched no
 *   row) throw and handle() maps them to 500.
 */
import { eq, inArray } from 'drizzle-orm';
import type { ApiContext } from 'waku/router';
import { getDb } from '../../../../db';
import { chats, messages } from '../../../../db/schema';
import { countLeaves, newestLeaf, removalSet } from '../../../../lib/message-tree';
import {
  pruneAttachments,
  storedAttachmentIds,
} from '../../../../server/attachments';
import {
  findChat,
  findMessage,
  isUuid,
  messageNotFound,
  toChatDto,
} from '../../../../server/chats';
import { handle } from '../../../../server/providers';
import { hasActiveRun } from '../../../../server/runs';

type Ctx = ApiContext<'/api/messages/[id]'>;

/*
 * DELETE /api/messages/:id — removes the message and everything that follows it on its
 * branches (see removalSet). the chat's leaf moves to the newest remaining sibling's tip
 * if it went with the deletion, else to the parent. uploads only the removed turns
 * carried are dropped as well.
 */
export const DELETE = (_req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return messageNotFound();
    const db = getDb();
    const target = await findMessage(db, userId, params.id);
    if (!target) return messageNotFound();
    if (hasActiveRun(target.chatId))
      return Response.json(
        { error: 'a reply is still generating in this chat' },
        { status: 409 },
      );
    const chat = await findChat(db, userId, target.chatId);
    if (!chat) throw new Error('chat not found');
    const all = await db
      .select()
      .from(messages)
      .where(eq(messages.chatId, chat.id))
      .orderBy(messages.createdAt);
    const { ids, root } = removalSet(all, target.id);
    const removed = all.filter((m) => ids.has(m.id));
    const rest = all.filter((m) => !ids.has(m.id));
    if (removed.length > 0) {
      await db
        .delete(messages)
        .where(inArray(messages.id, removed.map((m) => m.id)));
      /* uploads no surviving turn references any more go with the branch */
      await pruneAttachments(userId, storedAttachmentIds(removed));
    }

    let leafId = chat.leafId;
    if (leafId && ids.has(leafId)) {
      const sibling = rest.findLast(
        (m) => (m.parentId ?? null) === (root?.parentId ?? null),
      );
      leafId = sibling
        ? newestLeaf(rest, sibling.id)
        : (root?.parentId ?? null);
    }

    const [updatedChat] = await db
      .update(chats)
      .set({
        messageCount: rest.length,
        branchCount: Math.max(1, countLeaves(rest)),
        leafId,
      })
      .where(eq(chats.id, chat.id))
      .returning();
    if (!updatedChat) throw new Error('update failed');

    return Response.json(toChatDto(updatedChat));
  });

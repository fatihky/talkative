/*
 * MessageRegenerate — POST /api/messages/:id/regenerate — answer the
 * same user turn again, as a sibling branch.
 *
 * Business logic:
 * - auth via handle(); uuid check plus userId-scoped findMessage → 404
 *   for missing or foreign messages.
 * - body is parseGenerateInput: modelId required (400 without), plus
 *   optional thinkingLevel/toolGrants/toolProviders — unlike retry, a
 *   regenerate may switch model and tools.
 * - only an assistant reply with a parent qualifies (400 otherwise);
 *   the turn being re-answered is prev.parentId.
 * - 409 while hasActiveRun(chatId): one live generation per chat, so
 *   the current run must be stopped first.
 * - history = systemTurns + branchPath to the *parent*, with file
 *   attachments inlined (withAttachmentText) and attached note bodies
 *   resolved (attachedNotes) — the same assembly a fresh send uses, so
 *   the model sees exactly what it saw the first time.
 * - tree effect: the new reply is inserted as a *sibling* of :id (same
 *   parentId, status 'streaming', empty content); the old reply stays
 *   untouched as another branch. chat leafId moves to the new reply,
 *   messageCount and branchCount each +1, and chat modelId follows the
 *   picked model.
 * - startRun() registers the detached in-process run (server/runs.ts)
 *   keyed by the new message id and returns immediately — 201 with
 *   chat + assistant DTOs; the client streams the text from
 *   GET /api/messages/:newId/stream, and the run (not this route)
 *   flushes and finalizes the row.
 */
import { eq } from 'drizzle-orm';
import type { ApiContext } from 'waku/router';
import { getDb } from '../../../../../db';
import type { MessageRow } from '../../../../../db/schema';
import { chats, messages } from '../../../../../db/schema';
import { withAttachmentText } from '../../../../../server/attachments';
import {
  branchPath,
  findChat,
  findMessage,
  isUuid,
  messageNotFound,
  parseGenerateInput,
  toChatDto,
  toMessageDto,
} from '../../../../../server/chats';
import { handle, ValidationError } from '../../../../../server/providers';
import { collectRefs } from '../../../../../server/refs';
import {
  hasActiveRun,
  historyTurns,
  startRun,
} from '../../../../../server/runs';
import { isAdmin } from '../../../../../server/settings';
import { systemTurns } from '../../../../../server/system-prompt';
import { loadToolAuth, resolveTools } from '../../../../../server/tools';

type Ctx = ApiContext<'/api/messages/[id]/regenerate'>;

/*
 * POST /api/messages/:id/regenerate — answers the same user turn again as a sibling of
 * reply :id, with whatever model the body names. the old reply stays as another branch.
 * the new reply streams from GET /api/messages/:newId/stream like any other.
 */
export const POST = (req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return messageNotFound();
    const input = parseGenerateInput(await req.json());
    const db = getDb();
    const prev = await findMessage(db, userId, params.id);
    if (!prev) return messageNotFound();
    if (prev.role !== 'assistant' || !prev.parentId)
      throw new ValidationError('only replies can be regenerated');
    if (hasActiveRun(prev.chatId))
      return Response.json(
        { error: 'a reply is still generating in this chat' },
        { status: 409 },
      );
    const chat = await findChat(db, userId, prev.chatId);
    if (!chat) throw new Error('chat not found');

    const path = await branchPath(db, chat.id, prev.parentId);
    const inlined = await withAttachmentText(userId, path);
    const withText = path.map((m, i) => ({ ...m, attachments: inlined[i] }));
    const history = [
      ...(await systemTurns(db, chat)),
      ...historyTurns(withText, await collectRefs(db, userId, withText)),
    ];
    const assistantId = crypto.randomUUID();
    const [assistant] = await db
      .insert(messages)
      .values({
        id: assistantId,
        chatId: chat.id,
        parentId: prev.parentId,
        role: 'assistant',
        modelId: input.modelId,
        status: 'streaming',
        usage: null,
        latencyMs: null,
      } satisfies Partial<MessageRow>)
      .returning();
    if (!assistant) throw new Error('insert failed');

    const [updatedChat] = await db
      .update(chats)
      .set({
        messageCount: chat.messageCount + 1,
        branchCount: chat.branchCount + 1,
        modelId: input.modelId,
        leafId: assistantId,
      })
      .where(eq(chats.id, chat.id))
      .returning();
    if (!updatedChat) throw new Error('update failed');

    const auth = await loadToolAuth(userId, await isAdmin(userId));
    startRun({
      messageId: assistantId,
      chatId: chat.id,
      userId,
      modelId: input.modelId,
      thinkingLevel: input.thinkingLevel,
      history,
      tools: await resolveTools(input.toolGrants, input.toolProviders, auth),
    });
    return Response.json(
      { chat: toChatDto(updatedChat), assistant: toMessageDto(assistant) },
      { status: 201 },
    );
  });

/*
 * MessageRetry — POST /api/messages/:id/retry — rerun a failed tool
 * call mid-reply and let the model continue from there.
 *
 * Business logic:
 * - auth via handle(); uuid check plus userId-scoped findMessage → 404;
 *   body needs callId (400 without) alongside the usual
 *   parseGenerateInput fields (modelId required).
 * - only an assistant reply qualifies (400 otherwise); 409 while
 *   hasActiveRun(chatId) — one live generation per chat.
 * - resumeAt(prev, callId) finds the tool step holding that call and
 *   returns null unless the call's status is 'error' → 400 "only
 *   failed tool calls can be retried". it yields the reply as it stood
 *   *before* that step (text/toolCalls/thoughts cut back) plus replay
 *   turns for the earlier steps; the failed step's calls that did
 *   succeed keep their results and don't run again (runs.ts `kept`).
 * - vs regenerate: retry continues the same answer from the failed
 *   step (history = branch path to the parent + cut.turns, and startRun
 *   gets `resume` so the run replays the interrupted step as if the
 *   model had just asked for it); regenerate restarts the whole answer
 *   from the parent turn.
 * - tree effect matches regenerate: the new reply is a sibling of :id
 *   under the same parent, pre-seeded with the cut content so the
 *   branch shows what was already written; the old, partially failed
 *   reply survives as another branch; leafId/counts/modelId update the
 *   same way.
 * - startRun() detaches the generation; 201 with chat + assistant DTOs,
 *   streamed from GET /api/messages/:newId/stream.
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
  resumeAt,
  startRun,
} from '../../../../../server/runs';
import { isAdmin } from '../../../../../server/settings';
import { systemTurns } from '../../../../../server/system-prompt';
import { loadToolAuth, resolveTools } from '../../../../../server/tools';

type Ctx = ApiContext<'/api/messages/[id]/retry'>;

/*
 * POST /api/messages/:id/retry {callId, modelId, toolGrants, toolProviders} — reruns a
 * failed tool call of reply :id and lets the model carry on from there. the new reply is
 * a sibling that starts with everything written before that call's step; the old one
 * stays as another branch. it streams from GET /api/messages/:newId/stream as usual.
 */
export const POST = (req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return messageNotFound();
    const body = (await req.json().catch(() => null)) as {
      callId?: unknown;
    } | null;
    const callId = typeof body?.callId === 'string' ? body.callId : '';
    if (!callId) throw new ValidationError('callId is required');
    const input = parseGenerateInput(body);
    const db = getDb();
    const prev = await findMessage(db, userId, params.id);
    if (!prev) return messageNotFound();
    if (prev.role !== 'assistant' || !prev.parentId)
      throw new ValidationError('only replies have tool calls to retry');
    if (hasActiveRun(prev.chatId))
      return Response.json(
        { error: 'a reply is still generating in this chat' },
        { status: 409 },
      );
    const cut = resumeAt(prev, callId);
    if (!cut)
      throw new ValidationError('only failed tool calls can be retried');
    const chat = await findChat(db, userId, prev.chatId);
    if (!chat) throw new Error('chat not found');

    const path = await branchPath(db, chat.id, prev.parentId);
    const inlined = await withAttachmentText(userId, path);
    const withText = path.map((m, i) => ({ ...m, attachments: inlined[i] }));
    const history = [
      ...(await systemTurns(db, chat)),
      ...historyTurns(withText, await collectRefs(db, userId, withText)),
      ...cut.turns,
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
        content: cut.resume.text,
        toolCalls: cut.resume.toolCalls,
        thoughts: cut.resume.thoughts,
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
      resume: cut.resume,
    });
    return Response.json(
      { chat: toChatDto(updatedChat), assistant: toMessageDto(assistant) },
      { status: 201 },
    );
  });

/*
 * chats/[id]/messages — POST /api/chats/:id/messages — the send
 * endpoint: store a user turn, open an empty reply, start generating.
 *
 * Business logic:
 * - auth via handle() (401 without a session). A non-uuid :id is a 400
 *   here, not a 404: the chat id is client-minted, so a malformed one
 *   is a bad request while a well-formed unknown one means "create
 *   it". A well-formed id that already exists — including someone
 *   else's chat — is also a 400 ('chat id already exists') rather than
 *   an overwrite.
 * - 409 while hasActiveRun(chatId): one live generation per chat. The
 *   server-side queue was dropped in favour of this (16b80a3), so
 *   queueing is the client's job — the composer holds pending turns
 *   and resends them in order once the run settles. The check runs
 *   before the ownership lookup.
 * - create-on-first-send: no row for (id, userId) inserts one with the
 *   client's id, the sent modelId and firstPrompt = the raw text. The
 *   title is that text with leading [tag]/#tag noise stripped and cut
 *   to 48 chars, or the first attachment's name for a file-only send
 *   ('New chat' when that name is missing). A first send also carries
 *   the system prompt typed into the composer's chat-scope box, so its
 *   very first reply already runs with it; later sends never overwrite
 *   the stored prompt.
 * - branching: parentId omitted continues from chat.leafId, null
 *   starts a new root, and anything else must be an assistant message
 *   of this chat (400 'parentId must be a reply in this chat'). Naming
 *   the reply above an edited turn is exactly how a fork happens; when
 *   the chosen parent already has a child, this turn becomes a sibling
 *   and branchCount grows by one — the number behind the thread's
 *   branch badge (b4fc687).
 * - history is rebuilt server-side and never trusted from the client:
 *   systemTurns() stacks the folder prompts outermost-first ahead of
 *   the chat's own, branchPath() walks root → parent, and
 *   withAttachmentText() inlines stored file text (text-ish mimes, cut
 *   at TEXT_MAX) and turns images into base64 data urls; attachedNotes()
 *   inlines note bodies. historyTurns() then drops empty and failed
 *   replies, so the model never sees its own errors as context.
 * - only the newest turn goes out as multimodal content parts
 *   (userParts) when it carries an image; every other turn stays a
 *   plain string (userContent), which is what the providers' replay
 *   paths expect.
 * - two rows are written: the user turn — with attachments passed
 *   through stripText, since the bytes live in the attachments table
 *   and are re-read per run — and an empty assistant row with status
 *   'streaming'. Their createdAt values are 1ms apart so the
 *   user-before-assistant order survives a createdAt sort.
 * - the user row keeps its own toolGrants/toolProviders (93f46d9), so
 *   reopening the chat restores that turn's tool selection instead of
 *   today's; the chat row is updated in the same request
 *   (messageCount +2, leafId → the new reply, modelId → the sent one,
 *   branchCount as computed) and all three dtos come back as 201, so
 *   the client renders without refetching.
 * - streaming: startRun() registers a detached in-process run and is
 *   not awaited — generation outlives this request and the run, not
 *   this route, flushes and finalizes the assistant row. The reply is
 *   read from GET /api/messages/:assistantId/stream (SSE, re-openable
 *   at any time) and cancelled via …/stop; dropping the POST response
 *   does not stop it.
 * - tools are resolved per send, not per chat: loadToolAuth(userId,
 *   isAdmin(userId)) collects the caller's own credentials plus, for
 *   admins only unless settings share them, the env-provided keys, and
 *   resolveTools() keeps only the granted tools whose backend is
 *   usable (b2ce0a2).
 * - nothing rolls back on a later failure, so an inserted pair whose
 *   run never started is left 'streaming' and settled to 'interrupted'
 *   by the next GET of the chat; a lost write race throws → 500.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { ApiContext } from 'waku/router';
import { getDb } from '../../../../../db';
import type { MessageRow } from '../../../../../db/schema';
import { chats, messages } from '../../../../../db/schema';
import {
  stripText,
  withAttachmentText,
} from '../../../../../server/attachments';
import {
  branchPath,
  findChat,
  isUuid,
  parseSendInput,
  parseTimestampPrefix,
  toChatDto,
  toMessageDto,
} from '../../../../../server/chats';
import { handle, ValidationError } from '../../../../../server/providers';
import { collectRefs } from '../../../../../server/refs';
import type { InlineAttachment } from '../../../../../server/runs';
import {
  hasActiveRun,
  historyTurns,
  localStamp,
  prefixTurn,
  startRun,
  userContent,
  userParts,
} from '../../../../../server/runs';
import { isAdmin } from '../../../../../server/settings';
import { systemTurns } from '../../../../../server/system-prompt';
import { loadToolAuth, resolveTools } from '../../../../../server/tools';

type Ctx = ApiContext<'/api/chats/[id]/messages'>;

/** Strip leading tag-like patterns from chat titles: `[tag]`, `#tag` */
const stripTagsFromTitle = (text: string): string => {
  let cleaned = text.trim();
  /* remove leading [tag] or [tag name] patterns */
  cleaned = cleaned.replace(/^\[[^\]]+\]\s*/, '');
  /* remove leading #tag patterns (one or more) */
  cleaned = cleaned.replace(/^(#\w+\s*)+/, '');
  return cleaned.trim() || text.trim();
};

/*
 * POST /api/chats/:id/messages — stores the user turn plus an empty assistant turn and
 * starts generating in the background. the reply is read from
 * GET /api/messages/:assistantId/stream, which can be re-opened at any time.
 * the chat is created on first send; its id comes from the client so it can navigate right away.
 * `parentId` picks where the turn goes: an earlier reply's id (or null for the root) branches
 * off there, which is how editing a user message works; omitted, it continues the current branch.
 */
export const POST = (req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) throw new ValidationError('chat id must be a uuid');
    const input = parseSendInput(await req.json());
    /* an optional `[yyyy/mm/dd HH:mm]` prefix backdates this turn and its reply */
    const stamp = parseTimestampPrefix(input.content);
    if (stamp) input.content = stamp.text;
    if (hasActiveRun(params.id))
      return Response.json(
        { error: 'a reply is still generating in this chat' },
        { status: 409 },
      );

    const db = getDb();
    const text = input.content.trim();

    let chat = await findChat(db, userId, params.id);

    if (!chat) {
      /* the id is client-minted, so it may already be taken by another user's chat */
      const [taken] = await db
        .select({ id: chats.id })
        .from(chats)
        .where(eq(chats.id, params.id))
        .limit(1);
      if (taken) throw new ValidationError('chat id already exists');
      const [created] = await db
        .insert(chats)
        .values({
          id: params.id,
          userId,
          title:
            text === ''
              ? (input.attachments[0]?.name ?? 'New chat')
              : stripTagsFromTitle(text).slice(0, 48),
          modelId: input.modelId,
          firstPrompt: input.content,
          /* the composer's prompt for a chat that doesn't exist yet applies to this first reply too */
          ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        })
        .returning();
      if (!created) throw new Error('insert failed');
      chat = created;
    }

    const parentId =
      input.parentId === undefined ? (chat.leafId ?? null) : input.parentId;
    if (parentId !== null) {
      const [parent] = await db
        .select()
        .from(messages)
        .where(and(eq(messages.id, parentId), eq(messages.chatId, chat.id)))
        .limit(1);
      if (parent?.role !== 'assistant')
        throw new ValidationError('parentId must be a reply in this chat');
    }
    /* a parent that already has a follow-up gains a sibling, i.e. a new branch */
    const [childrenResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(messages)
      .where(
        parentId !== null
          ? eq(messages.parentId, parentId)
          : and(
              eq(messages.chatId, chat.id),
              sql`${messages.parentId} is null`,
            ),
      );
    const existingChildren = Number(childrenResult?.count ?? 0);
    const newBranchCount =
      existingChildren > 0 ? chat.branchCount + 1 : chat.branchCount;

    const path = await branchPath(db, chat.id, parentId);
    const enriched = await withAttachmentText(userId, [
      ...path,
      { attachments: input.attachments },
    ]);
    const withText = path.map((m, i) => ({
      ...m,
      attachments: enriched[i] ?? [],
    }));
    const refs = await collectRefs(db, userId, withText);
    const lastAttachment = enriched.at(-1) ?? [];
    const lastHasImage = (lastAttachment as InlineAttachment[]).some(
      (a) => a.dataUrl !== undefined,
    );
    /* +1ms keeps user-before-assistant ordering stable under createdAt sort */
    const now = stamp?.at ?? Date.now();
    /* the newest user turn isn't produced by historyTurns, so stamp it here */
    const prefix = input.timestamps ? localStamp(now) : undefined;

    const history = [
      ...(await systemTurns(db, chat)),
      ...historyTurns(withText, refs, { timestamps: input.timestamps }),
      prefixTurn(
        {
          role: 'user' as const,
          content: lastHasImage
            ? userParts(
                { attachments: lastAttachment, content: input.content },
                refs,
              )
            : userContent(
                { attachments: lastAttachment, content: input.content },
                refs,
              ),
        },
        prefix,
      ),
    ];
    const userMessageId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();

    const [user] = await db
      .insert(messages)
      .values({
        id: userMessageId,
        chatId: chat.id,
        parentId,
        role: 'user',
        content: input.content,
        attachments: input.attachments.map(stripText),
        modelId: input.modelId,
        /* the turn keeps its own tool selection, so the chat reopens with it */
        toolGrants: input.toolGrants,
        toolProviders: input.toolProviders,
        usage: null,
        latencyMs: null,
        createdAt: new Date(now),
      } satisfies Partial<MessageRow>)
      .returning();
    if (!user) throw new Error('insert failed');

    const [assistant] = await db
      .insert(messages)
      .values({
        id: assistantId,
        chatId: chat.id,
        parentId: userMessageId,
        role: 'assistant',
        modelId: input.modelId,
        status: 'streaming',
        usage: null,
        latencyMs: null,
        createdAt: new Date(now + 1),
      } satisfies Partial<MessageRow>)
      .returning();
    if (!assistant) throw new Error('insert failed');

    const [updatedChat] = await db
      .update(chats)
      .set({
        messageCount: chat.messageCount + 2,
        modelId: input.modelId,
        leafId: assistantId,
        branchCount: newBranchCount,
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
      {
        chat: toChatDto(updatedChat),
        user: toMessageDto(user),
        assistant: toMessageDto(assistant),
      },
      { status: 201 },
    );
  });

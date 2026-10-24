/*
 * server/chats — shared chat and message plumbing behind every chat route.
 *
 * Business logic:
 * - toChatDto/toMessageDto are the only shapes the API returns: optional
 *   columns are left out rather than sent as null, timestamps become epoch
 *   ms, and internal fields (userId, queuedAt) never cross the wire.
 * - ownership is enforced in the lookup, not the route: findChat matches
 *   (id, userId) and findMessage joins through the chat, because messages
 *   carry no userId of their own. someone else's row reads as missing, so
 *   callers answer chatNotFound()/messageNotFound() — a 404, never a 403.
 * - isUuid gates every id that arrives in a path or a body; routes reject a
 *   malformed one before touching the database.
 * - parseSystemPrompt reads undefined as "leave as is" and null or blank as
 *   "clear"; folders reuse it, so a chat's prompt and its folder chain obey
 *   the same rule.
 * - parseGenerateInput requires a modelId, takes thinkingLevel only from
 *   off/low/medium/high, and keeps just the correctly typed entries of
 *   toolGrants/toolProviders — unknown tool ids are dropped later, when the
 *   run resolves its tools.
 * - parseSendInput needs content or attachments; parentId must be a uuid,
 *   null to start a new root branch, or omitted to continue the chat's
 *   stored leaf. that one field is how editing a turn forks a branch.
 * - newestLeafId follows the newest child (findLast) down from a message,
 *   so opening a chat lands on the most recent tip of its leaf.
 * - branchPath loads the chat's messages once and walks parent pointers up
 *   from the leaf, returning root-first order; the length guard stops a
 *   corrupt cycle from spinning forever.
 * - parseChatPatch is the chat's whole editable surface — title, category,
 *   tags, folderId, leafId, systemPrompt — plus `pinned`, which becomes
 *   pinnedAt = now or null. pinnedAt is only an ordering key: the sidebar
 *   floats pinned chats to the top, most recently pinned first.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db';
import type { ChatRow, MessageRow } from '../db/schema';
import { chats, messages } from '../db/schema';
import type {
  Attachment,
  ChatSummary,
  Message as MessageDto,
  ThinkingLevel,
} from '../types';
import { ValidationError } from './providers';

export const toChatDto = (c: ChatRow): ChatSummary => ({
  id: c.id,
  title: c.title,
  modelId: c.modelId,
  branchCount: c.branchCount,
  messageCount: c.messageCount,
  costUsd: Number(c.costUsd),
  ...(c.category ? { category: c.category } : {}),
  tags: c.tags,
  ...(c.folderId ? { folderId: c.folderId } : {}),
  ...(c.pinnedAt ? { pinnedAt: c.pinnedAt.getTime() } : {}),
  ...(c.systemPrompt ? { systemPrompt: c.systemPrompt } : {}),
  firstPrompt: c.firstPrompt,
  createdAt: c.createdAt.getTime(),
  updatedAt: c.updatedAt.getTime(),
});

export const toMessageDto = (m: MessageRow): MessageDto => ({
  id: m.id,
  parentId: m.parentId ?? null,
  role: m.role,
  content: m.content,
  attachments: m.attachments as MessageDto['attachments'],
  ...(m.modelId ? { modelId: m.modelId } : {}),
  status: m.status,
  ...(m.error ? { error: m.error } : {}),
  ...(m.toolGrants
    ? { toolGrants: m.toolGrants as MessageDto['toolGrants'] }
    : {}),
  ...(m.toolProviders
    ? { toolProviders: m.toolProviders as MessageDto['toolProviders'] }
    : {}),
  ...(m.toolCalls && (m.toolCalls as unknown[]).length > 0
    ? { toolCalls: m.toolCalls as MessageDto['toolCalls'] }
    : {}),
  ...(m.thoughts && (m.thoughts as unknown[]).length > 0
    ? { thoughts: m.thoughts as MessageDto['thoughts'] }
    : {}),
  ...(m.refusal ? { refusal: m.refusal } : {}),
  ...(m.annotations && (m.annotations as unknown[]).length > 0
    ? { annotations: m.annotations as MessageDto['annotations'] }
    : {}),
  ...(m.usage ? { usage: m.usage as MessageDto['usage'] } : {}),
  ...(m.usageDetails
    ? { usageDetails: m.usageDetails as MessageDto['usageDetails'] }
    : {}),
  ...(m.routing ? { routing: m.routing as MessageDto['routing'] } : {}),
  ...(m.latencyMs ? { latencyMs: m.latencyMs } : {}),
  createdAt: m.createdAt.getTime(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID.test(s);

/*
 * parses a leading `[yyyy/mm/dd HH:mm]` prefix off a message. when present it
 * backdates the turn (and its reply) to that local wall-clock time, which is how
 * a long-running chat gets historical entries slotted into the transcript; the
 * prefix is control text, so it is dropped from the stored content. returns
 * null when the text doesn't open with a well-formed prefix, leaving it untouched.
 */
export const parseTimestampPrefix = (
  content: string,
): { at: number; text: string } | null => {
  const m = /^\[(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2})\]/.exec(content);
  if (!m) return null;
  const [, year, month, day, hour, minute] = m;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const at = new Date(y, mo - 1, d, h, mi).getTime();
  if (Number.isNaN(at)) return null;
  return { at, text: content.slice(m[0].length) };
};

/* the inverse of parseTimestampPrefix: epoch ms → "[yyyy/mm/dd HH:mm]" in local time */
export const formatTimestampPrefix = (ts: number): string => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `[${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}]`;
};

/* undefined = leave as is; null or blank clears it */
export const parseSystemPrompt = (v: unknown): string | null | undefined => {
  if (v === undefined || v === null) return v;
  if (typeof v !== 'string')
    throw new ValidationError('systemPrompt must be a string or null');
  return v.trim() === '' ? null : v;
};

/** the user's chat with this id; someone else's reads as missing */
export const findChat = (db: Db, userId: string, id: string) =>
  db
    .select()
    .from(chats)
    .where(and(eq(chats.id, id), eq(chats.userId, userId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);

/** a message in one of the user's chats; messages are owned through their chat */
export const findMessage = (db: Db, userId: string, id: string) =>
  db
    .select({ message: messages })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .where(and(eq(messages.id, id), eq(chats.userId, userId)))
    .limit(1)
    .then((rows) => rows[0]?.message ?? null);

export const chatNotFound = () =>
  Response.json({ error: 'chat not found' }, { status: 404 });
export const messageNotFound = () =>
  Response.json({ error: 'message not found' }, { status: 404 });

export type GenerateInput = {
  modelId: string;
  thinkingLevel?: ThinkingLevel | undefined;
  toolGrants: Record<string, boolean>;
  toolProviders: Record<string, string>;
};

export type SendInput = GenerateInput & {
  content: string;
  attachments: Attachment[];
  /* the reply this turn follows; null starts a new root branch, undefined appends to the chat's leaf */
  parentId?: string | null | undefined;
  /* a not-yet-created chat's own prompt, stored with the row the first send inserts */
  systemPrompt?: string | null | undefined;
  /* prefix every turn in the history sent to the model with its [yyyy/mm/dd HH:mm] timestamp */
  timestamps?: boolean | undefined;
};

/* keeps only entries whose value has the expected type; unknown tool ids are dropped later */
const record = <T>(
  v: unknown,
  ok: (x: unknown) => x is T,
): Record<string, T> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (Object.fromEntries(Object.entries(v).filter(([, x]) => ok(x))) as Record<
        string,
        T
      >)
    : {};

export const parseGenerateInput = (body: unknown): GenerateInput => {
  const b = (body ?? {}) as Record<string, unknown>;
  const modelId = typeof b.modelId === 'string' ? b.modelId.trim() : '';
  if (!modelId) throw new ValidationError('modelId is required');
  const thinkingLevel =
    typeof b.thinkingLevel === 'string' &&
    ['off', 'low', 'medium', 'high'].includes(b.thinkingLevel)
      ? (b.thinkingLevel as ThinkingLevel)
      : undefined;
  return {
    modelId,
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    toolGrants: record(b.toolGrants, (x): x is boolean => typeof x === 'boolean'),
    toolProviders: record(
      b.toolProviders,
      (x): x is string => typeof x === 'string',
    ),
  };
};

export const parseSendInput = (body: unknown): SendInput => {
  const b = (body ?? {}) as Record<string, unknown>;
  const content = typeof b.content === 'string' ? b.content : '';
  const attachments = Array.isArray(b.attachments)
    ? (b.attachments as Attachment[])
    : [];
  if (content.trim() === '' && attachments.length === 0)
    throw new ValidationError('content or attachments required');
  if (
    b.parentId !== undefined &&
    b.parentId !== null &&
    (typeof b.parentId !== 'string' || !isUuid(b.parentId))
  )
    throw new ValidationError('parentId must be a message id or null');
  return {
    ...parseGenerateInput(body),
    content,
    attachments,
    ...(b.parentId !== undefined ? { parentId: b.parentId } : {}),
    ...(b.systemPrompt !== undefined
      ? { systemPrompt: parseSystemPrompt(b.systemPrompt) }
      : {}),
    timestamps: b.timestamps === true,
  };
};

/** follows the newest child down from `id` to the tip of that branch */
export const newestLeafId = (
  msgs: MessageRow[],
  id: string | null,
): string | null => {
  if (!id) return null;
  let leaf = id;
  for (let i = 0; i < msgs.length; i++) {
    const child = msgs.findLast((m) => m.parentId === leaf);
    if (!child) break;
    leaf = child.id;
  }
  return leaf;
};

/** root-to-`leafId` path through a chat's message tree, oldest first */
export const branchPath = async (
  db: Db,
  chatId: string,
  leafId: string | null,
): Promise<MessageRow[]> => {
  if (!leafId) return [];
  const all = await db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId));
  const byId = new Map(all.map((m) => [m.id, m]));
  const out: MessageRow[] = [];
  /* the size guard stops a corrupt cycle from spinning forever */
  for (
    let m = byId.get(leafId);
    m && out.length < all.length;
    m = m.parentId ? byId.get(m.parentId) : undefined
  )
    out.push(m);
  return out.reverse();
};

type ChatPatch = Partial<
  Pick<
    ChatRow,
    'title' | 'category' | 'tags' | 'folderId' | 'leafId' | 'systemPrompt'
  >
> & { pinnedAt?: Date | null };

/** rename / classification / move / branch-switch / system prompt patch; every field optional */
export const parseChatPatch = (body: unknown): ChatPatch => {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: ChatPatch = {};
  if (b.title !== undefined) {
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    if (!title) throw new ValidationError('title must be a non-empty string');
    out.title = title;
  }
  if (b.category !== undefined) {
    if (b.category !== null && typeof b.category !== 'string')
      throw new ValidationError('category must be a string or null');
    out.category = b.category;
  }
  if (b.tags !== undefined) {
    if (!Array.isArray(b.tags) || b.tags.some((t) => typeof t !== 'string'))
      throw new ValidationError('tags must be an array of strings');
    out.tags = b.tags as string[];
  }
  if (b.pinned !== undefined) {
    if (typeof b.pinned !== 'boolean')
      throw new ValidationError('pinned must be a boolean');
    out.pinnedAt = b.pinned ? new Date() : null;
  }
  /* null files the chat back at the top level */
  if (b.folderId !== undefined) {
    if (
      b.folderId !== null &&
      (typeof b.folderId !== 'string' || !isUuid(b.folderId))
    )
      throw new ValidationError('folderId must be a folder id or null');
    out.folderId = b.folderId;
  }
  if (b.leafId !== undefined) {
    if (typeof b.leafId !== 'string' || !isUuid(b.leafId))
      throw new ValidationError('leafId must be a message id');
    out.leafId = b.leafId;
  }
  const systemPrompt = parseSystemPrompt(b.systemPrompt);
  if (systemPrompt !== undefined) out.systemPrompt = systemPrompt;
  return out;
};
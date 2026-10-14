/*
 * Classify — best-effort category/tags labelling for a chat, fired by
 * the client right after the chat's first user message
 * (POST /api/chats/:id/classify, non-blocking).
 *
 * Business logic:
 * - the model is firstEnabledModel — whatever the user's enabled
 *   providers serve first; labeling isn't worth a dedicated pick. no
 *   provider, a demo-catalog model or a vanished connection all
 *   return {} so the chat simply stays unlabeled.
 * - the prompt is the title plus the first message (only when it
 *   differs, capped at 2000 chars) — enough to label without sending
 *   the whole thread; the call asks for json only
 *   (response_format json_object) with a 20 s timeout.
 * - the system prompt pins `category` to a fixed six-value list
 *   (backend/frontend/infra/research/writing/debugging) and `tags` to
 *   at most 4 short lowercase keywords; parseClassification then
 *   re-enforces the real limits (40-char category, 4 tags × 24
 *   chars) rather than trusting the reply.
 * - parsing tolerates prose or a code fence around the object (first
 *   `{` to last `}`); malformed or oversized values degrade to fewer
 *   or no labels instead of an error.
 * - a failing model call throws; the route catches and logs it,
 *   stores whatever labels came back on the chat row and still
 *   answers 200 — classification must never fail its caller.
 */
import type { ChatRow } from '../db/schema';
import type { Model } from '../types';
import { completeText } from './complete';
import { parseModelId } from './model-id';
import { firstEnabledModel } from './models';
import { findConnection } from './providers';

const CATEGORIES = [
  'backend',
  'frontend',
  'infra',
  'research',
  'writing',
  'debugging',
];
const MAX_TAGS = 4;
const MAX_TAG_LEN = 24;

export type Classification = { category?: string; tags?: string[] };

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t !== '' && t.length <= max ? t : null;
};

/* tolerate the model wrapping the object in prose or a code fence */
const parseJson = (raw: string): Record<string, unknown> | null => {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

export const parseClassification = (raw: string): Classification => {
  const obj = parseJson(raw);
  if (!obj) return {};
  const category = clean(obj.category, 40);
  const tags = Array.isArray(obj.tags)
    ? obj.tags
        .map((t) => clean(t, MAX_TAG_LEN))
        .filter((t): t is string => t !== null)
        .slice(0, MAX_TAGS)
    : [];
  return {
    ...(category ? { category } : {}),
    ...(tags.length > 0 ? { tags } : {}),
  };
};

const promptFor = (chat: Pick<ChatRow, 'title' | 'firstPrompt'>): string =>
  [
    'Classify this chat.',
    `Title: ${chat.title}`,
    chat.firstPrompt && chat.firstPrompt !== chat.title
      ? `First message: ${chat.firstPrompt.slice(0, 2000)}`
      : '',
  ]
    .filter((s) => s !== '')
    .join('\n');

/**
 * asks a configured model to categorise a chat; returns an empty result when no
 * provider is available or the model fails, so callers can silently skip it.
 */
export const classifyChat = async (
  userId: string,
  chat: Pick<ChatRow, 'title' | 'firstPrompt'>,
): Promise<Classification> => {
  const model: Model | null = await firstEnabledModel(userId);
  if (!model) return {};
  const parsed = parseModelId(model.id);
  if (!parsed) return {};
  const conn = await findConnection(userId, parsed.connectionId);
  if (!conn) return {};
  const raw = await completeText(
    conn,
    parsed.remoteId,
    [
      {
        role: 'system',
        content:
          'You label chat threads. Reply with a single JSON object and nothing else. ' +
          `"category" must be one of: ${CATEGORIES.join(', ')}. ` +
          `"tags" must be an array of at most ${MAX_TAGS} short lowercase keywords. ` +
          'Include "category", "tags", or both.',
      },
      { role: 'user', content: promptFor(chat) },
    ],
    { json: true, timeoutMs: 20_000 },
  );
  return parseClassification(raw);
};

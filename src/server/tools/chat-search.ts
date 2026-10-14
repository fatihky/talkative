/*
 * tools/chat-search — keyword search across the user's other chats.
 *
 * Business logic:
 * - matches chat titles and message content with case-insensitive substring
 *   (ILIKE); the query is escaped first so a user-typed % or _ can't act as
 *   a wildcard.
 * - strictly scoped to ctx.userId, and the chat being answered is excluded
 *   (looked up via the reply's messageId) because it is already in the
 *   model's context.
 * - the message scan spans every branch of the other chats and takes the
 *   newest limit*4 matches; title hits seed the result set, and each chat
 *   keeps at most 2 snippets — a ~160-char window around the first hit, so
 *   the model sees why the message matched.
 * - limit is clamped to 1–20 (default 8) and title-matched chats come
 *   first, then message-matched ones newest first.
 * - the output is markdown the model can quote: "## title (chat <id>,
 *   updated <date>)" plus role-tagged snippet lines — the chat id lets a
 *   follow-up (e.g. a link) point at the source; no hits returns
 *   `no chats match "<q>"`.
 * - read-only and keyless ('default' backend): always available when
 *   granted (off by default).
 */
import { and, desc, eq, ilike, inArray, ne } from 'drizzle-orm';
import { getDb } from '../../db';
import { chats, messages } from '../../db/schema';
import type { ServerTool } from './index';

const LIMIT_MAX = 20;
const SNIPPET = 160;

/* the query is user text; % and _ would otherwise act as wildcards */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/* a window around the first hit, so the model sees why the message matched */
const snippet = (text: string, q: string) => {
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  const start = Math.max(0, at - SNIPPET / 2);
  const end = Math.min(text.length, start + SNIPPET);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
};

export const chatSearch: ServerTool = {
  id: 'chat_search',
  description:
    "Search the user's other chats by keyword. Matches chat titles and message text " +
    '(case-insensitive substring) and returns the matching chats with snippets, newest first. ' +
    'Use it when the user refers to something discussed in a previous conversation.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'words or phrase to look for; keep it short and specific',
      },
      limit: {
        type: 'integer',
        description: `max chats to return, 1-${LIMIT_MAX}; default 8`,
      },
    },
    required: ['query'],
  },
  backends: () => [{ id: 'default' }],
  async run(args, ctx) {
    const q = typeof args.query === 'string' ? args.query.trim() : '';
    if (!q) throw new Error('query is required');
    const limit = Math.min(
      LIMIT_MAX,
      Math.max(1, typeof args.limit === 'number' ? Math.floor(args.limit) : 8),
    );
    const db = getDb();
    /* the chat being answered is already in context */
    const self = await db
      .select({ chatId: messages.chatId })
      .from(messages)
      .where(eq(messages.id, ctx.messageId))
      .then((rows) => rows[0]?.chatId ?? null);
    const like = `%${escapeLike(q)}%`;

    const [byTitle, msgs] = await Promise.all([
      db
        .select()
        .from(chats)
        .where(
          and(
            eq(chats.userId, ctx.userId),
            ilike(chats.title, like),
            ...(self ? [ne(chats.id, self)] : []),
          ),
        )
        .orderBy(desc(chats.updatedAt))
        .limit(limit),
      db
        .select({
          chatId: messages.chatId,
          role: messages.role,
          content: messages.content,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .innerJoin(chats, eq(chats.id, messages.chatId))
        .where(
          and(
            eq(chats.userId, ctx.userId),
            ilike(messages.content, like),
            ...(self ? [ne(messages.chatId, self)] : []),
          ),
        )
        .orderBy(desc(messages.createdAt))
        .limit(limit * 4),
    ]);

    /* one entry per chat, keeping its newest matching message */
    const hits = new Map<string, { role: string; text: string }[]>();
    for (const c of byTitle) hits.set(c.id, []);
    for (const m of msgs) {
      const list = hits.get(m.chatId) ?? [];
      if (list.length < 2)
        list.push({ role: m.role, text: snippet(m.content, q) });
      hits.set(m.chatId, list);
    }
    const ids = [...hits.keys()].slice(0, limit);
    if (!ids.length) return `no chats match "${q}"`;

    const chatRows = await db
      .select()
      .from(chats)
      .where(and(inArray(chats.id, ids), eq(chats.userId, ctx.userId)));
    const byId = new Map(chatRows.map((c) => [c.id, c]));
    return ids
      .map((id) => {
        const c = byId.get(id);
        if (!c) return '';
        const head = `## ${c.title} (chat ${c.id}, updated ${c.updatedAt.toISOString().slice(0, 10)})`;
        const lines = (hits.get(id) ?? []).map((h) => `- ${h.role}: ${h.text}`);
        return [head, ...lines].join('\n');
      })
      .filter(Boolean)
      .join('\n\n');
  },
};

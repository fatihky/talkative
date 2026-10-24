/*
 * tools/chat-search — keyword search across the user's other chats.
 *
 * Business logic:
 * - runs the same ranked full-text search as GET /api/search
 *   (server/search.ts): prefix words, "phrases", -exclusions and `or`, with
 *   a substring fallback for plain text, so the model can search the way a
 *   person types.
 * - strictly scoped to ctx.userId, and the chat being answered is excluded
 *   (looked up via the reply's messageId) because it is already in the
 *   model's context.
 * - the message scan spans every branch of the other chats and takes the
 *   best limit*4 matches by rank; title hits seed the result set, and each
 *   chat keeps at most 2 snippets — a short excerpt around the match, with
 *   the highlight marks stripped, so the model sees why the message matched.
 * - limit is clamped to 1–20 (default 8) and title-matched chats come
 *   first, then message-matched ones in rank order.
 * - the output is markdown the model can quote: "## title (chat <id>,
 *   updated <date>)" plus role-tagged snippet lines — the chat id lets a
 *   follow-up (e.g. a link) point at the source; no hits returns
 *   `no chats match "<q>"`.
 * - read-only and keyless ('default' backend): always available when
 *   granted (off by default).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../db';
import { chats, messages } from '../../db/schema';
import {
  parseQuery,
  searchChatTitles,
  searchMessages,
  stripMarks,
} from '../search';
import type { ServerTool } from './index';

const LIMIT_MAX = 20;

export const chatSearch: ServerTool = {
  id: 'chat_search',
  description:
    "Search the user's other chats by keyword. Matches chat titles and message text " +
    '(words match as prefixes; "quoted phrase", -exclude and `or` work too) and returns the ' +
    'best-matching chats with snippets. ' +
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
      .then((rows) => rows[0]?.chatId ?? undefined);
    const parsed = parseQuery(q);

    const [byTitle, msgs] = await Promise.all([
      searchChatTitles(db, ctx.userId, parsed, limit, self),
      searchMessages(
        db,
        ctx.userId,
        parsed,
        { excludeChatId: self },
        { limit: limit * 4, offset: 0 },
      ),
    ]);

    /* title hits first, then chats in the order of their best message */
    const hits = new Map<string, { role: string; text: string }[]>();
    for (const c of byTitle) hits.set(c.id, []);
    for (const m of msgs.hits) {
      const list = hits.get(m.chatId) ?? [];
      if (list.length < 2)
        list.push({ role: m.role, text: stripMarks(m.snippet) });
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

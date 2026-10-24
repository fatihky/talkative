/*
 * search — GET /api/search?q=… — global search across the user's chats.
 *
 * Business logic:
 * - auth via handle() (401 without a session); scoped by userId.
 * - matches chat titles and every message's content, across every branch
 *   (the messages scan does not care about leaf paths, so a message parked
 *   on a dead branch still surfaces), with a case-insensitive substring
 *   (ILIKE); the query is escaped first so a user-typed % or _ can't act
 *   as a wildcard.
 * - results group into two buckets: title hits (the whole chat) and
 *   message hits (a ~160-char window around the first match, plus the chat
 *   title). Message hits carry the message id so the caller can deep-link
 *   into the branch; a chat may appear in both buckets.
 * - bounded: 20 title hits and 40 message hits, message hits deduped so a
 *   single chat returns at most 2 snippets, newest first.
 */
import { and, desc, eq, ilike } from 'drizzle-orm';
import { getDb } from '../../../db';
import { chats, messages } from '../../../db/schema';
import { handle } from '../../../server/providers';

const SNIPPET = 160;
const TITLE_LIMIT = 20;
const MSG_LIMIT = 40;
const MSG_PER_CHAT = 2;

/* the query is user text; % and _ would otherwise act as wildcards */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/* a window around the first hit, so the row explains why it matched */
const snippet = (text: string, q: string) => {
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  const start = Math.max(0, at - SNIPPET / 2);
  const end = Math.min(text.length, start + SNIPPET);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
};

/* GET /api/search?q=… — title + message hits across all branches */
export const GET = (req: Request) =>
  handle(async (userId) => {
    const q = new URL(req.url).searchParams.get('q')?.trim() ?? '';
    if (!q) return Response.json({ chats: [], messages: [] });
    const db = getDb();
    const like = `%${escapeLike(q)}%`;

    const [titleRows, msgRows] = await Promise.all([
      db
        .select({
          id: chats.id,
          title: chats.title,
          updatedAt: chats.updatedAt,
        })
        .from(chats)
        .where(and(eq(chats.userId, userId), ilike(chats.title, like)))
        .orderBy(desc(chats.updatedAt))
        .limit(TITLE_LIMIT),
      db
        .select({
          id: messages.id,
          chatId: messages.chatId,
          chatTitle: chats.title,
          role: messages.role,
          content: messages.content,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .innerJoin(chats, eq(chats.id, messages.chatId))
        .where(and(eq(chats.userId, userId), ilike(messages.content, like)))
        .orderBy(desc(messages.createdAt))
        .limit(MSG_LIMIT * MSG_PER_CHAT),
    ]);

    /* at most 2 snippets per chat, newest first, so one chat can't crowd the rest */
    const seen = new Map<string, number>();
    const messageHits = [];
    for (const m of msgRows) {
      const n = seen.get(m.chatId) ?? 0;
      if (n >= MSG_PER_CHAT) continue;
      seen.set(m.chatId, n + 1);
      messageHits.push({
        id: m.id,
        chatId: m.chatId,
        chatTitle: m.chatTitle,
        role: m.role,
        snippet: snippet(m.content, q),
      });
    }

    return Response.json({
      chats: titleRows.map((c) => ({
        id: c.id,
        title: c.title,
      })),
      messages: messageHits,
    });
  });

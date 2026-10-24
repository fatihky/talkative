/*
 * search — GET /api/search?q=… — ranked full-text search across the user's chats.
 *
 * Business logic:
 * - auth via handle() (401 without a session); scoped by userId.
 * - query syntax, ranking, the substring fallback and snippet marking live
 *   in server/search.ts; this route only parses params. Message hits span
 *   every branch (a message parked on a dead branch still surfaces) and
 *   carry the message id so the caller can open its branch with ?m=.
 * - params: role (user|assistant), chat, folder (covers subfolders), model,
 *   after/before (ISO dates; invalid ones are ignored), extra=1 to also
 *   search reasoning and tool-call output, sort (relevance|newest), limit
 *   (1–50, default 20) and offset for paging.
 * - title hits come only with the first page (offset 0), at most 20; the
 *   response also echoes the parsed positive terms so the ui can highlight
 *   them in the opened thread, and `next` is the following page's offset
 *   or null.
 */
import { getDb } from '../../../db';
import { handle } from '../../../server/providers';
import {
  type MessageFilters,
  parseQuery,
  searchChatTitles,
  searchMessages,
} from '../../../server/search';

const TITLE_LIMIT = 20;
const LIMIT_MAX = 50;

const date = (v: string | null) => {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
};

/* GET /api/search?q=… — title + message hits across all branches */
export const GET = (req: Request) =>
  handle(async (userId) => {
    const p = new URL(req.url).searchParams;
    const parsed = parseQuery(p.get('q') ?? '');
    const role = p.get('role');
    const filters: MessageFilters = {
      role: role === 'user' || role === 'assistant' ? role : undefined,
      chatId: p.get('chat') || undefined,
      folderId: p.get('folder') || undefined,
      modelId: p.get('model') || undefined,
      after: date(p.get('after')),
      before: date(p.get('before')),
      extra: p.get('extra') === '1',
    };
    const limit = Math.min(
      LIMIT_MAX,
      Math.max(1, Number.parseInt(p.get('limit') ?? '', 10) || 20),
    );
    const offset = Math.max(0, Number.parseInt(p.get('offset') ?? '', 10) || 0);
    const sort = p.get('sort') === 'newest' ? 'newest' : 'relevance';
    const db = getDb();

    const [titles, msgs] = await Promise.all([
      offset === 0 && !filters.chatId
        ? searchChatTitles(db, userId, parsed, TITLE_LIMIT)
        : Promise.resolve([]),
      searchMessages(db, userId, parsed, filters, { limit, offset, sort }),
    ]);

    return Response.json({
      chats: titles.map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt.getTime(),
      })),
      messages: msgs.hits.map((m) => ({
        id: m.id,
        chatId: m.chatId,
        chatTitle: m.chatTitle,
        folderId: m.folderId,
        role: m.role,
        modelId: m.modelId,
        createdAt: m.createdAt.getTime(),
        snippet: m.snippet,
        in: m.in,
      })),
      terms: parsed.terms,
      next: msgs.next,
    });
  });

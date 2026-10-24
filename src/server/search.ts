/*
 * search — ranked full-text search over a user's messages and chat titles,
 * shared by GET /api/search and the chat_search tool.
 *
 * Business logic:
 * - parseQuery turns web-style input into a tsquery: bare words AND
 *   together and match as prefixes (`deploy` finds "deploying", and the
 *   last word still matches while it's being typed), "quoted phrases" match
 *   words in order, `-word` excludes, and `or` between two terms ORs them.
 *   Terms are cut down to letters and digits first, so user text never
 *   reaches to_tsquery's own syntax; a query of only exclusions matches
 *   nothing rather than everything.
 * - plain input (no quotes, `-` or `or`) of 3+ characters also matches as a
 *   case-insensitive substring through the trigram index, so code fragments,
 *   urls and mid-word text still hit; LIKE wildcards are escaped.
 * - the doc expressions come from schema.ts so the planner uses the GIN
 *   expression indexes. `extra` also searches reasoning text and tool-call
 *   args/results, which are noisy and so off by default.
 * - ranking is ts_rank_cd (extra matches weigh half, substring-only hits a
 *   small constant) damped by a log of the message's age in months, so a
 *   strong old match still beats a weak new one; sort 'newest' ignores rank.
 * - every query is scoped to the user through the chats join; filters are
 *   role, chat, folder (including its subfolders), model and a created-at
 *   range, and `excludeChatId` drops one chat (the tool's own).
 * - pages are offset-based: limit+1 rows are read so `next` is the next
 *   offset, or null on the last page. headlines are built only for the
 *   page's rows, in a second query.
 * - snippets wrap matches in MARK_START/MARK_END (private-use characters,
 *   never HTML) so the client renders highlights without trusting markup;
 *   a hit that only matched as a substring, or only in its extra text, gets
 *   a window around the match instead, marked the same way.
 */
import {
  and,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Db } from '../db';
import {
  chats,
  folders,
  messageExtraDoc,
  messageExtraText,
  messageSearchDoc,
  messages,
  SEARCH_DOC_CHARS,
} from '../db/schema';
import { MARK_END, MARK_START } from '../lib/search-marks';

const SNIPPET = 160;
const HEADLINE_OPTS = `StartSel="${MARK_START}", StopSel="${MARK_END}", MaxWords=28, MinWords=12, ShortWord=2, MaxFragments=2, FragmentDelimiter=" … "`;

export type ParsedQuery = {
  /* to_tsquery('simple', …) input, or null when no positive term survived */
  tsquery: string | null;
  /* the raw text for the substring fallback, or null when syntax was used */
  plain: string | null;
  /* positive words, for client-side highlighting */
  terms: string[];
};

const words = (s: string) =>
  (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(Boolean);

/* a bare token: its words in order, the last one as a prefix */
const prefixClause = (ws: string[]) =>
  ws.map((w, i) => (i === ws.length - 1 ? `${w}:*` : w)).join(' <-> ');

export const parseQuery = (input: string): ParsedQuery => {
  const q = input.trim();
  const clauses: { text: string; positive: boolean }[] = [];
  const terms: string[] = [];
  let syntax = false;
  let pendingOr = false;
  for (const m of q.matchAll(/(-?)"([^"]*)"?|(\S+)/g)) {
    const neg = m[1] === '-' || (m[3]?.startsWith('-') ?? false);
    const phrase = m[2] !== undefined;
    const raw = phrase ? (m[2] ?? '') : (m[3] ?? '').replace(/^-/, '');
    if (phrase || neg) syntax = true;
    if (!phrase && !neg && raw.toLowerCase() === 'or' && clauses.length) {
      syntax = true;
      pendingOr = true;
      continue;
    }
    const ws = words(raw);
    if (!ws.length) continue;
    const body = phrase ? ws.join(' <-> ') : prefixClause(ws);
    const text = neg ? `!(${body})` : `(${body})`;
    if (!neg) terms.push(...ws);
    const last = clauses[clauses.length - 1];
    if (pendingOr && last) {
      last.text = `(${last.text} | ${text})`;
      last.positive = last.positive || !neg;
    } else clauses.push({ text, positive: !neg });
    pendingOr = false;
  }
  const tsquery = clauses.some((c) => c.positive)
    ? clauses.map((c) => c.text).join(' & ')
    : null;
  const plain = !syntax && q.length >= 3 ? q : null;
  return { tsquery, plain, terms: [...new Set(terms)] };
};

/* the query is user text; % and _ would otherwise act as wildcards */
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/* a window around the first case-insensitive hit of `q`, with that hit marked */
export const windowSnippet = (text: string, q: string) => {
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return text.slice(0, SNIPPET).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, at - SNIPPET / 2);
  const end = Math.min(text.length, start + SNIPPET);
  const mark = (s: string, from: number, to: number) =>
    `${s.slice(0, from)}${MARK_START}${s.slice(from, to)}${MARK_END}${s.slice(to)}`;
  const body = mark(
    text.slice(start, end),
    at - start,
    Math.min(end, at + q.length) - start,
  )
    .replace(/\s+/g, ' ')
    .trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
};

export const stripMarks = (s: string) =>
  s.replaceAll(MARK_START, '').replaceAll(MARK_END, '');

export type MessageFilters = {
  role?: 'user' | 'assistant' | undefined;
  chatId?: string | undefined;
  folderId?: string | undefined;
  modelId?: string | undefined;
  after?: Date | undefined;
  before?: Date | undefined;
  /* also search reasoning and tool-call args/results */
  extra?: boolean | undefined;
  excludeChatId?: string | undefined;
};

export type MessageHit = {
  id: string;
  chatId: string;
  chatTitle: string;
  folderId: string | null;
  role: 'user' | 'assistant';
  modelId: string | null;
  createdAt: Date;
  snippet: string;
  /* where the match was found: the reply text or its reasoning/tool output */
  in: 'content' | 'extra';
};

/* the folder and every folder nested under it, so a folder filter covers its subtree */
const folderSubtree = async (db: Db, userId: string, root: string) => {
  const rows = await db
    .select({ id: folders.id, parentId: folders.parentId })
    .from(folders)
    .where(eq(folders.userId, userId));
  const out = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of rows)
      if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
        out.add(f.id);
        grew = true;
      }
  }
  return [...out];
};

export const searchMessages = async (
  db: Db,
  userId: string,
  q: ParsedQuery,
  f: MessageFilters,
  page: { limit: number; offset: number; sort?: 'relevance' | 'newest' },
): Promise<{ hits: MessageHit[]; next: number | null }> => {
  if (!q.tsquery && !q.plain) return { hits: [], next: null };
  const doc = messageSearchDoc(messages.content);
  const extraDoc = messageExtraDoc(messages.thoughts, messages.toolCalls);
  const tsq = q.tsquery ? sql`to_tsquery('simple', ${q.tsquery})` : null;
  const like = q.plain ? `%${escapeLike(q.plain)}%` : null;

  const match: SQL[] = [];
  if (tsq) {
    match.push(sql`${doc} @@ ${tsq}`);
    if (f.extra) match.push(sql`${extraDoc} @@ ${tsq}`);
  }
  if (like) match.push(ilike(messages.content, like));

  const rel: SQL[] = [];
  if (tsq) {
    rel.push(sql`ts_rank_cd(${doc}, ${tsq}, 32)`);
    if (f.extra) rel.push(sql`0.5 * ts_rank_cd(${extraDoc}, ${tsq}, 32)`);
  }
  if (like)
    rel.push(
      sql`case when ${messages.content} ilike ${like} then 0.05 else 0 end`,
    );
  const ageMonths = sql`greatest(0, extract(epoch from (localtimestamp - ${messages.createdAt}))) / 2592000`;
  const score = sql`(${sql.join(rel, sql` + `)}) / (1 + ln(1 + ${ageMonths}))`;

  const folderIds = f.folderId
    ? await folderSubtree(db, userId, f.folderId)
    : null;
  const where = and(
    eq(chats.userId, userId),
    or(...match),
    f.role ? eq(messages.role, f.role) : undefined,
    f.chatId ? eq(messages.chatId, f.chatId) : undefined,
    folderIds ? inArray(chats.folderId, folderIds) : undefined,
    f.modelId ? eq(messages.modelId, f.modelId) : undefined,
    f.after ? gte(messages.createdAt, f.after) : undefined,
    f.before ? lte(messages.createdAt, f.before) : undefined,
    f.excludeChatId ? ne(messages.chatId, f.excludeChatId) : undefined,
  );

  const rows = await db
    .select({
      id: messages.id,
      chatId: messages.chatId,
      chatTitle: chats.title,
      folderId: chats.folderId,
      role: messages.role,
      modelId: messages.modelId,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .where(where)
    .orderBy(
      ...(page.sort === 'newest'
        ? [desc(messages.createdAt)]
        : [desc(score), desc(messages.createdAt)]),
    )
    .limit(page.limit + 1)
    .offset(page.offset);
  const more = rows.length > page.limit;
  const pageRows = rows.slice(0, page.limit);
  if (!pageRows.length) return { hits: [], next: null };

  /* headlines only for the rows on this page; ts_headline re-parses the whole doc */
  const cap = sql.raw(String(SEARCH_DOC_CHARS));
  const heads = await db
    .select({
      id: messages.id,
      head: tsq
        ? sql<string>`ts_headline('simple'::regconfig, left(${messages.content}, ${cap}), ${tsq}, ${HEADLINE_OPTS})`
        : sql<string>`''`,
      extraHead:
        tsq && f.extra
          ? sql<string>`ts_headline('simple'::regconfig, ${messageExtraText(messages.thoughts, messages.toolCalls)}, ${tsq}, ${HEADLINE_OPTS})`
          : sql<string>`''`,
      /* a window around the first substring hit, for hits the tsquery didn't mark */
      around: like
        ? sql<string>`substr(${messages.content}, greatest(1, strpos(lower(${messages.content}), lower(${q.plain})) - ${SNIPPET}), ${SNIPPET * 3})`
        : sql<string>`''`,
      lead: sql<string>`left(${messages.content}, ${SNIPPET})`,
    })
    .from(messages)
    .where(
      inArray(
        messages.id,
        pageRows.map((r) => r.id),
      ),
    );
  const byId = new Map(heads.map((h) => [h.id, h]));
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

  const hits = pageRows.map((r): MessageHit => {
    const h = byId.get(r.id);
    let snippet = '';
    let at: MessageHit['in'] = 'content';
    if (h?.head.includes(MARK_START)) snippet = clean(h.head);
    else if (q.plain && h?.around) snippet = windowSnippet(h.around, q.plain);
    else if (h?.extraHead.includes(MARK_START)) {
      snippet = clean(h.extraHead);
      at = 'extra';
    } else snippet = clean(h?.lead ?? '');
    return { ...r, folderId: r.folderId ?? null, snippet, in: at };
  });
  return { hits, next: more ? page.offset + page.limit : null };
};

export type ChatHit = { id: string; title: string; updatedAt: Date };

/** chats whose title matches: word/prefix match through the tsquery, or a plain substring */
export const searchChatTitles = async (
  db: Db,
  userId: string,
  q: ParsedQuery,
  limit: number,
  excludeChatId?: string,
): Promise<ChatHit[]> => {
  if (!q.tsquery && !q.plain) return [];
  const match: SQL[] = [];
  if (q.tsquery)
    match.push(
      sql`to_tsvector('simple'::regconfig, ${chats.title}) @@ to_tsquery('simple', ${q.tsquery})`,
    );
  if (q.plain) match.push(ilike(chats.title, `%${escapeLike(q.plain)}%`));
  return db
    .select({ id: chats.id, title: chats.title, updatedAt: chats.updatedAt })
    .from(chats)
    .where(
      and(
        eq(chats.userId, userId),
        or(...match),
        excludeChatId ? ne(chats.id, excludeChatId) : undefined,
      ),
    )
    .orderBy(desc(chats.updatedAt))
    .limit(limit);
};

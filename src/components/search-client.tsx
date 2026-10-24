/*
 * SearchClient — the /search page: every match for a query, with filters.
 *
 * Business logic:
 * - The query and filters live in the url (q, role, folder, model, range,
 *   after, before, extra, sort, chat) so a search can be reloaded, shared
 *   or reached from the palette's "See all results"; edits rewrite it with
 *   history.replaceState rather than a navigation, so typing never
 *   re-renders the route; a real navigation to /search (the palette while
 *   already here) resets them from the new url.
 * - Fetches are debounced (200ms) and the previous request is aborted, so
 *   only the newest query's results land. A filter change restarts from the
 *   first page; scrolling to the sentinel (or the "Load more" button)
 *   fetches the next one at the server's `next` offset.
 * - Title matches come with the first page only and sit above the
 *   messages. Message hits are grouped by chat in the order each chat first
 *   appears in the ranking, so a later page can add to a group already on
 *   screen.
 * - range is a rolling window (7d/30d/1y) or custom dates, where `before`
 *   covers its whole day; folder covers its subfolders (server side); extra
 *   also searches reasoning and tool output, and such hits are labelled.
 * - Opening a hit goes to /c/<chat>?m=<message>&q=<query>, which opens its
 *   branch, centers the message and highlights the words.
 */
'use client';

import {
  type ComponentProps,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type Link, useRouter } from 'waku';
import { type SearchHit, type SearchParams, searchApi } from '../lib/api';
import { fullTimestamp, timeAgo } from '../lib/format';
import { I } from '../lib/icons';
import { Marked } from '../lib/search';
import {
  actions,
  folderPath,
  useChatsStore,
  useFoldersStore,
  useModelsStore,
} from '../stores';
import { SegmentedControl } from '../ui/primitives';

type RoutePath = Extract<ComponentProps<typeof Link>['to'], string>;

const PAGE = 25;
const DAY = 86_400_000;
const RANGES = { '7d': 7, '30d': 30, '1y': 365 } as const;

type Filters = {
  q: string;
  role: '' | 'user' | 'assistant';
  folder: string;
  model: string;
  range: '' | keyof typeof RANGES | 'custom';
  after: string;
  before: string;
  extra: boolean;
  sort: 'relevance' | 'newest';
  chat: string;
};

const fromUrl = (search: string): Filters => {
  const p = new URLSearchParams(search);
  const role = p.get('role');
  const range = p.get('range') ?? '';
  return {
    q: p.get('q') ?? '',
    role: role === 'user' || role === 'assistant' ? role : '',
    folder: p.get('folder') ?? '',
    model: p.get('model') ?? '',
    range:
      range in RANGES || range === 'custom' ? (range as Filters['range']) : '',
    after: p.get('after') ?? '',
    before: p.get('before') ?? '',
    extra: p.get('extra') === '1',
    sort: p.get('sort') === 'newest' ? 'newest' : 'relevance',
    chat: p.get('chat') ?? '',
  };
};

const toUrl = (f: Filters) => {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  if (f.role) p.set('role', f.role);
  if (f.folder) p.set('folder', f.folder);
  if (f.model) p.set('model', f.model);
  if (f.range) p.set('range', f.range);
  if (f.range === 'custom' && f.after) p.set('after', f.after);
  if (f.range === 'custom' && f.before) p.set('before', f.before);
  if (f.extra) p.set('extra', '1');
  if (f.sort !== 'relevance') p.set('sort', f.sort);
  if (f.chat) p.set('chat', f.chat);
  const s = p.toString();
  return s ? `/search?${s}` : '/search';
};

/* the filters as api params; a rolling range is measured from now */
const toParams = (f: Filters, offset: number): SearchParams => {
  let after: string | undefined;
  let before: string | undefined;
  if (f.range && f.range !== 'custom')
    after = new Date(Date.now() - RANGES[f.range] * DAY).toISOString();
  if (f.range === 'custom') {
    if (f.after) after = new Date(`${f.after}T00:00:00`).toISOString();
    if (f.before) before = new Date(`${f.before}T23:59:59.999`).toISOString();
  }
  return {
    q: f.q.trim(),
    role: f.role || undefined,
    folder: f.folder || undefined,
    model: f.model || undefined,
    chat: f.chat || undefined,
    after,
    before,
    extra: f.extra,
    sort: f.sort,
    limit: PAGE,
    offset,
  };
};

const selectCls =
  'h-7 max-w-[180px] rounded-[6px] border border-[var(--border)] bg-[var(--raised)] px-1.5 text-[12px]';

export function SearchClient() {
  const router = useRouter();
  const [f, setF] = useState<Filters>(() => fromUrl(router.query));
  const [chatHits, setChatHits] = useState<
    { id: string; title: string; updatedAt: number }[]
  >([]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);
  /* aborts the in-flight first page or "more" request when the query changes */
  const ctl = useRef<AbortController | null>(null);

  const folders = useFoldersStore((s) => s.items);
  const models = useModelsStore((s) => s.items);
  const chats = useChatsStore((s) => s.items);

  useEffect(() => {
    actions.setContext('new');
    inputRef.current?.focus();
  }, []);

  const set = (patch: Partial<Filters>) =>
    setF((cur) => ({ ...cur, ...patch }));

  /* a real navigation here (e.g. the palette's "See all results" while on
     /search) replaces the filters; our own replaceState never changes router.query */
  const seenQuery = useRef(router.query);
  useEffect(() => {
    if (router.query === seenQuery.current) return;
    seenQuery.current = router.query;
    setF(fromUrl(router.query));
  }, [router.query]);

  /* the url mirrors the filters without a navigation */
  useEffect(() => {
    const to = toUrl(f);
    if (`${location.pathname}${location.search}` !== to)
      history.replaceState(history.state, '', to);
  }, [f]);

  /* first page: debounced, newest request wins */
  useEffect(() => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    if (!f.q.trim()) {
      setChatHits([]);
      setHits([]);
      setNext(null);
      setStatus('idle');
      return;
    }
    setStatus('loading');
    const t = setTimeout(() => {
      searchApi
        .search(toParams(f, 0), c.signal)
        .then((res) => {
          setChatHits(res.chats);
          setHits(res.messages);
          setNext(res.next);
          setStatus('ready');
        })
        .catch(() => {
          if (!c.signal.aborted) setStatus('error');
        });
    }, 200);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [f]);

  const loadMore = () => {
    if (next === null || loadingMore || status !== 'ready') return;
    const c = ctl.current;
    setLoadingMore(true);
    searchApi
      .search(toParams(f, next), c?.signal)
      .then((res) => {
        setHits((cur) => [...cur, ...res.messages]);
        setNext(res.next);
      })
      .catch(() => {
        /* a failed page leaves the button to retry */
      })
      .finally(() => setLoadingMore(false));
  };

  /* infinite scroll: the sentinel under the list pulls the next page */
  // biome-ignore lint/correctness/useExhaustiveDependencies: loadMore reads the current state
  useEffect(() => {
    const el = sentinel.current;
    if (!el || next === null) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) loadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [next, status, loadingMore, hits.length]);

  /* hits grouped by chat, groups in order of their best-ranked hit */
  const groups = useMemo(() => {
    const out = new Map<string, { title: string; hits: SearchHit[] }>();
    for (const h of hits) {
      const g = out.get(h.chatId) ?? { title: h.chatTitle, hits: [] };
      g.hits.push(h);
      out.set(h.chatId, g);
    }
    return [...out.entries()];
  }, [hits]);

  const folderOptions = useMemo(
    () =>
      folders
        .map((x) => ({ id: x.id, label: folderPath(folders, x.id) }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [folders],
  );
  const modelName = (id: string | null) =>
    id ? (models.find((m) => m.id === id)?.shortName ?? id) : '';
  const scopedChat = f.chat
    ? (chats.find((c) => c.id === f.chat)?.title ?? 'one chat')
    : null;

  const open = (h: SearchHit) =>
    void router.push(
      `/c/${h.chatId}?m=${encodeURIComponent(h.id)}&q=${encodeURIComponent(f.q.trim())}` as RoutePath,
    );

  return (
    <main className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4 sm:px-6">
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-3">
        <h1 className="text-[20px] leading-[1.35] font-semibold">Search</h1>

        <div className="flex h-10 items-center gap-2 rounded-[8px] border border-[var(--border)] bg-[var(--sunken)] px-3 focus-within:border-[var(--accent)]">
          <I n="search" s={15} className="muted shrink-0" />
          <input
            ref={inputRef}
            value={f.q}
            onChange={(e) => set({ q: e.target.value })}
            placeholder='Search messages — "exact phrase", -exclude, a or b'
            aria-label="Search messages"
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--text-3)]"
          />
          {f.q && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                set({ q: '' });
                inputRef.current?.focus();
              }}
              className="ctl-icon size-6 shrink-0 border-transparent bg-transparent"
            >
              <I n="x" s={11} />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <SegmentedControl
            ariaLabel="Author"
            disabled={false}
            value={f.role}
            options={[
              { value: '', label: 'All' },
              { value: 'user', label: 'You' },
              { value: 'assistant', label: 'Assistant' },
            ]}
            onChange={(v) => set({ role: v as Filters['role'] })}
          />
          <select
            aria-label="Time range"
            value={f.range}
            onChange={(e) => set({ range: e.target.value as Filters['range'] })}
            className={selectCls}
          >
            <option value="">Any time</option>
            <option value="7d">Past week</option>
            <option value="30d">Past month</option>
            <option value="1y">Past year</option>
            <option value="custom">Custom…</option>
          </select>
          {f.range === 'custom' && (
            <>
              <input
                type="date"
                aria-label="From"
                value={f.after}
                max={f.before || undefined}
                onChange={(e) => set({ after: e.target.value })}
                className={selectCls}
              />
              <span className="muted">–</span>
              <input
                type="date"
                aria-label="To"
                value={f.before}
                min={f.after || undefined}
                onChange={(e) => set({ before: e.target.value })}
                className={selectCls}
              />
            </>
          )}
          {folderOptions.length > 0 && (
            <select
              aria-label="Folder"
              value={f.folder}
              onChange={(e) => set({ folder: e.target.value })}
              className={selectCls}
            >
              <option value="">All folders</option>
              {folderOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label="Model"
            value={f.model}
            onChange={(e) => set({ model: e.target.value })}
            className={selectCls}
          >
            <option value="">Any model</option>
            {f.model && !models.some((m) => m.id === f.model) && (
              <option value={f.model}>{f.model}</option>
            )}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.shortName}
              </option>
            ))}
          </select>
          <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--text-2)]">
            <input
              type="checkbox"
              checked={f.extra}
              onChange={(e) => set({ extra: e.target.checked })}
            />
            Reasoning &amp; tool output
          </label>
          <span className="flex-1" />
          <select
            aria-label="Sort"
            value={f.sort}
            onChange={(e) => set({ sort: e.target.value as Filters['sort'] })}
            className={selectCls}
          >
            <option value="relevance">Best match</option>
            <option value="newest">Newest</option>
          </select>
        </div>

        {scopedChat && (
          <div className="flex items-center gap-1.5 text-[12px]">
            <span className="muted">Only in</span>
            <span className="flex items-center gap-1 rounded-[4px] bg-[var(--sunken)] px-1.5 py-0.5">
              {scopedChat}
              <button
                type="button"
                aria-label="Search all chats"
                onClick={() => set({ chat: '' })}
                className="muted hover:text-[var(--text)]"
              >
                <I n="x" s={10} />
              </button>
            </span>
          </div>
        )}

        {status === 'idle' && (
          <p className="py-8 text-center text-[12px] muted">
            Words match as prefixes, in any order. Use quotes for a phrase,
            -word to exclude and “or” for either term.
          </p>
        )}
        {status === 'error' && (
          <div className="text-[12px] text-[var(--danger)]" role="alert">
            Search failed — try again.
          </div>
        )}
        {status === 'loading' && hits.length === 0 && (
          <div className="py-8 text-center text-[12px] muted">Searching…</div>
        )}
        {status === 'ready' && hits.length === 0 && chatHits.length === 0 && (
          <div className="py-8 text-center text-[12px] muted">
            No messages match “{f.q.trim()}”.
          </div>
        )}

        {chatHits.length > 0 && (
          <section className="flex flex-col gap-1">
            <div className="sec-label">
              Chats
              <span className="num ml-1.5 text-[11px] font-normal">
                {chatHits.length}
              </span>
            </div>
            <div className="flex flex-col">
              {chatHits.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => void router.push(`/c/${c.id}` as RoutePath)}
                  className="flex items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left hover:bg-[var(--sunken)]"
                >
                  <I
                    n="chat"
                    s={13}
                    className="shrink-0 text-[var(--text-3)]"
                  />
                  <span className="min-w-0 flex-1 truncate text-[13px]">
                    {c.title}
                  </span>
                  <span
                    className="num shrink-0 text-[11px] muted"
                    title={fullTimestamp(c.updatedAt)}
                  >
                    {timeAgo(c.updatedAt)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}

        {groups.length > 0 && (
          <section className="flex flex-col gap-3">
            <div className="sec-label">Messages</div>
            {groups.map(([chatId, g]) => (
              <div
                key={chatId}
                className="flex flex-col rounded-[8px] border border-[var(--border)]"
              >
                <button
                  type="button"
                  onClick={() => void router.push(`/c/${chatId}` as RoutePath)}
                  className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-1.5 text-left hover:bg-[var(--sunken)]"
                >
                  <I
                    n="chat"
                    s={12}
                    className="shrink-0 text-[var(--text-3)]"
                  />
                  <span className="min-w-0 flex-1 truncate text-[12px] font-[500]">
                    {g.title}
                  </span>
                  <span className="num shrink-0 text-[11px] muted">
                    {g.hits.length}
                    {g.hits.length === 1 ? ' match' : ' matches'}
                  </span>
                </button>
                {g.hits.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => open(h)}
                    className="flex items-start gap-2 px-3 py-2 text-left hover:bg-[var(--sunken)]"
                  >
                    <I
                      n={h.role === 'user' ? 'user' : 'bot'}
                      s={13}
                      className="mt-[2px] shrink-0 text-[var(--text-3)]"
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="line-clamp-3 text-[13px] leading-[1.5] text-[var(--text-2)]">
                        <Marked text={h.snippet} lead={90} />
                      </span>
                      <span className="num flex items-center gap-2 text-[11px] muted">
                        <span>
                          {h.role === 'user'
                            ? 'You'
                            : modelName(h.modelId) || 'Assistant'}
                        </span>
                        {h.in === 'extra' && (
                          <span className="rounded-[4px] bg-[var(--sunken)] px-1 text-[10px]">
                            reasoning / tools
                          </span>
                        )}
                        <span title={fullTimestamp(h.createdAt)}>
                          {timeAgo(h.createdAt)}
                        </span>
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            ))}
          </section>
        )}

        {next !== null && (
          <div ref={sentinel} className="flex justify-center py-3">
            <button
              type="button"
              className="ctl h-7 px-3 text-[12px]"
              disabled={loadingMore}
              onClick={loadMore}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

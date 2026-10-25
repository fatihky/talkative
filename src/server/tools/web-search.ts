/*
 * tools/web-search — live web search through interchangeable backends.
 *
 * Business logic:
 * - six backends whose ids match the provider-key registry: tavily,
 *   serper.dev, serpapi, exa, scrape.do (the same key its http_fetch
 *   backend uses) and searxng — whose credential is the self-hosted
 *   instance URL rather than a secret, and whose instance must enable the
 *   json search format.
 * - every backend is keyed, so without an own key or an admissible env key
 *   the tool is unavailable and never offered to the model; a provider that
 *   lost its key between resolution and run throws "no search backend is
 *   configured".
 * - the result count is layered: the model's count arg (1–10) wins, then
 *   the user's per-tool web_search result-count preference, then 5;
 *   searxng and scrape.do take no count param, so one page of hits is
 *   sliced down to n.
 * - timeouts are per backend: 15s default, 30s for searxng (it fans out to
 *   its engines and waits on the slowest), 60s for scrape.do (it scrapes
 *   google live and retries blocks) — each raced against the run's abort
 *   signal; upstream HTTP errors throw "search → <status>: <body>" which
 *   the model receives as an error result.
 * - the model sees numbered title/url/snippet blocks ('no results' when
 *   empty); the untouched upstream response is returned as `raw` so the ui
 *   can show it exactly as it came.
 * - one of the two throttled tools: calls run under the concurrency
 *   semaphore, per user for an own key or per provider for a shared env
 *   key, when the user has the preference set.
 */
import type { ServerTool } from './index';
import { callWithRetry } from './rate-limit';

type Hit = { title: string; url: string; snippet: string };
type Backend = {
  search: (
    provider: string,
    q: string,
    n: number,
    key: string,
    signal: AbortSignal,
  ) => Promise<{ hits: Hit[]; raw: string }>;
};

const TIMEOUT_MS = 15_000;

/*
 * the request is retried with backoff when the backend answers 429; the
 * cooldown scope is per backend so a shared key throttles across users while
 * an own key throttles per user (the caller passes the resolved provider id).
 */
const call = async (
  provider: string,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  timeout = TIMEOUT_MS,
): Promise<{ json: unknown; raw: string }> => {
  const res = await callWithRetry(`web_search:${provider}`, signal, (s) =>
    fetch(url, {
      ...init,
      signal: AbortSignal.any([s, AbortSignal.timeout(timeout)]),
    }),
  );
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`search → ${res.status}${body ? `: ${body}` : ''}`);
  }
  /* kept as text so the ui can show the response exactly as it came */
  const raw = await res.text();
  return { json: JSON.parse(raw) as unknown, raw };
};

/* ids match the provider-key ids in the tool-credentials registry */
const BACKENDS: Record<string, Backend> = {
  tavily: {
    async search(provider, q, n, key, signal) {
      const { json, raw } = await call(
        provider,
        'https://api.tavily.com/search',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${key}`,
          },
          body: JSON.stringify({ query: q, max_results: n }),
        },
        signal,
      );
      const data = json as {
        results?: { title?: string; url?: string; content?: string }[];
      };
      return {
        raw,
        hits: (data.results ?? []).map((r) => ({
          title: r.title ?? '',
          url: r.url ?? '',
          snippet: r.content ?? '',
        })),
      };
    },
  },
  'serper.dev': {
    async search(provider, q, n, key, signal) {
      const { json, raw } = await call(
        provider,
        'https://google.serper.dev/search',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': key },
          body: JSON.stringify({ q, num: n }),
        },
        signal,
      );
      const data = json as {
        organic?: { title?: string; link?: string; snippet?: string }[];
      };
      return {
        raw,
        hits: (data.organic ?? []).map((r) => ({
          title: r.title ?? '',
          url: r.link ?? '',
          snippet: r.snippet ?? '',
        })),
      };
    },
  },
  serpapi: {
    async search(provider, q, n, key, signal) {
      const qs = new URLSearchParams({
        engine: 'google',
        q,
        num: String(n),
        api_key: key,
      });
      const { json, raw } = await call(
        provider,
        `https://serpapi.com/search.json?${qs}`,
        {},
        signal,
      );
      const data = json as {
        organic_results?: { title?: string; link?: string; snippet?: string }[];
      };
      return {
        raw,
        hits: (data.organic_results ?? []).map((r) => ({
          title: r.title ?? '',
          url: r.link ?? '',
          snippet: r.snippet ?? '',
        })),
      };
    },
  },
  /* self-hosted, so the credential value is the instance url rather than a key;
     the instance must list `json` under search.formats in settings.yml */
  searxng: {
    async search(provider, q, n, base, signal) {
      const root = base.replace(/\/+$/, '').replace(/\/search$/, '');
      const qs = new URLSearchParams({ q, format: 'json' });
      const { json, raw } = await call(
        provider,
        `${root}/search?${qs}`,
        { headers: { accept: 'application/json' } },
        signal,
        /* it fans out to its upstream engines and waits on the slowest */
        30_000,
      );
      const data = json as {
        results?: { title?: string; url?: string; content?: string }[];
      };
      /* no result count param either; one page is whatever the engines return */
      return {
        raw,
        hits: (data.results ?? []).slice(0, n).map((r) => ({
          title: r.title ?? '',
          url: r.url ?? '',
          snippet: r.content ?? '',
        })),
      };
    },
  },
  exa: {
    async search(provider, q, n, key, signal) {
      const { json, raw } = await call(
        provider,
        'https://api.exa.ai/search',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': key,
          },
          body: JSON.stringify({
            query: q,
            numResults: n,
            type: 'auto',
            contents: { highlights: true },
          }),
        },
        signal,
      );
      const data = json as {
        results?: {
          title?: string;
          url?: string;
          highlights?: string[];
          text?: string;
        }[];
      };
      return {
        raw,
        hits: (data.results ?? []).map((r) => ({
          title: r.title ?? '',
          url: r.url ?? '',
          snippet: r.highlights?.join('\n') ?? r.text?.slice(0, 500) ?? '',
        })),
      };
    },
  },
  /* same key as the http_fetch backend */
  'scrape.do': {
    async search(provider, q, n, key, signal) {
      /* no result count param; a page holds ~10 organic results, so slice */
      const qs = new URLSearchParams({ token: key, q });
      const { json, raw } = await call(
        provider,
        `https://api.scrape.do/plugin/google/search?${qs}`,
        {},
        signal,
        /* it scrapes google live and retries blocks upstream, so it's slower */
        60_000,
      );
      const data = json as {
        organic_results?: { title?: string; link?: string; snippet?: string }[];
      };
      return {
        raw,
        hits: (data.organic_results ?? []).slice(0, n).map((r) => ({
          title: r.title ?? '',
          url: r.link ?? '',
          snippet: r.snippet ?? '',
        })),
      };
    },
  },
};

export const webSearch: ServerTool = {
  id: 'web_search',
  description:
    'Search the web. Returns titles, URLs and snippets for the top results. ' +
    'Use for anything recent or that you are unsure about; fetch a URL to read a full page.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'search query' },
      count: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description: 'results to return (default 5)',
      },
    },
    required: ['query'],
  },
  backends: () => Object.keys(BACKENDS).map((id) => ({ id, key: id })),
  async run(args, { signal, provider, apiKey, count }) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) throw new Error('query is required');
    const wanted = Math.trunc(Number(args.count)) || count || 5;
    const n = Math.min(10, Math.max(1, wanted));
    /* the picked backend may have lost its key since the grant was saved */
    const id = provider && BACKENDS[provider] ? provider : undefined;
    const backend = id ? BACKENDS[id] : undefined;
    const key = apiKey;
    if (!backend || !id || !key) throw new Error('no search backend is configured');
    const { hits, raw } = await backend.search(id, query, n, key, signal);
    if (!hits.length) return { result: 'no results', raw };
    return {
      result: hits
        .map((h, i) => `${i + 1}. ${h.title}\n${h.url}\n${h.snippet}`)
        .join('\n\n'),
      raw,
    };
  },
};

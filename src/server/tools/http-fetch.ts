/*
 * tools/http-fetch — GET a public URL and hand its content to the model as
 * text.
 *
 * Business logic:
 * - three backends: 'direct' (keyless, always available, so the tool itself
 *   is never gated), 'scrape.do' and 'tavily', each keyed by its
 *   same-named provider key — scrape.do shares its key with the web_search
 *   backend. A keyed backend that lost its key between resolution and run
 *   throws "… no longer configured".
 * - SSRF guard on direct fetches: the model picks the url, so every hop
 *   resolves the host and refuses private/reserved IPv4 and IPv6 ranges
 *   (including ::ffff:-mapped v4), keeping redis, postgres and cloud
 *   metadata out of reach; redirects are followed manually up to 5 and
 *   re-checked per hop. A dns rebind between lookup and connect can still
 *   slip through — accepted for a local app.
 * - scrape.do and tavily fetch from their own networks, so the guard
 *   doesn't apply; both return markdown, tavily surfaces per-url failure
 *   messages. Timeouts are per backend: 15s for direct (covering the whole
 *   redirect chain), 60s for scrape.do (it retries and rotates proxies),
 *   30s for tavily — each raced against the run's abort signal.
 * - bodies stream up to 2 MB and the reader is cancelled past that, so big
 *   downloads are cut instead of buffered whole; on direct fetches a
 *   non-text content-type yields "[binary content not shown]".
 * - HTML is stripped to text by a crude regex converter (scripts/styles/
 *   comments out, entities decoded): the model reads that as `result`
 *   while the pre-conversion page is kept as `raw` for the ui; markdown
 *   backends skip conversion and return no raw.
 * - the result always opens with "<status> <final url>" and the
 *   content-type, so the model knows what it actually read.
 * - one of the two throttled tools: calls run under the concurrency
 *   semaphore, per user for an own key or per provider for a shared env
 *   key, when the user has the preference set.
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { PRODUCT } from '../identity';
import type { ServerTool } from './index';
import { callWithRetry } from './rate-limit';

const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;

/*
 * the model picks the url, so it must not reach the server's own network (redis,
 * postgres, cloud metadata). checked per redirect hop; a dns rebind between the
 * lookup and the connect can still slip through, which is acceptable for a local app.
 */
const isPrivateV4 = (ip: string) => {
  const [a = 0, b = 0] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
};

const isPrivate = (ip: string) => {
  if (isIP(ip) === 4) return isPrivateV4(ip);
  const v6 = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)?.[1];
  if (mapped) return isPrivateV4(mapped);
  return (
    v6 === '::' ||
    v6 === '::1' ||
    v6.startsWith('fc') ||
    v6.startsWith('fd') ||
    /^fe[89ab]/.test(v6)
  );
};

const assertPublic = async (url: URL) => {
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('only http(s) urls can be fetched');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true });
  if (addrs.some((a) => isPrivate(a.address)))
    throw new Error('refusing to fetch a private or local address');
};

/* reads at most MAX_BYTES; big downloads are cut, not buffered whole */
const readCapped = async (res: Response) => {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size >= MAX_BYTES) {
      void reader.cancel().catch(() => {});
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
};

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/* crude html → text; good enough for a model to read, no dom needed */
const htmlToText = (html: string) =>
  html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === '#')
        return String.fromCodePoint(
          e[1] === 'x' || e[1] === 'X'
            ? parseInt(e.slice(2), 16)
            : Number(e.slice(1)),
        );
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();

/* scrape.do retries and rotates proxies upstream, so it gets its own budget */
const SCRAPEDO_TIMEOUT_MS = 60_000;

type Fetched = { res: Response; url: URL; markdown?: boolean };

const fetchDirect = async (
  start: URL,
  signal: AbortSignal,
): Promise<Fetched> => {
  let url = start;
  const sig = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublic(url);
    const res = await fetch(url, {
      redirect: 'manual',
      signal: sig,
      headers: {
        'user-agent': `${PRODUCT} (+http_fetch tool)`,
        accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5',
      },
    });
    const loc = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !loc) return { res, url };
    void res.body?.cancel().catch(() => {});
    url = new URL(loc, url);
  }
  throw new Error('too many redirects');
};

/*
 * the request leaves from scrape.do's network, not ours, so the private-address
 * check doesn't apply; it follows redirects itself and can return markdown
 */
const fetchScrapeDo = async (
  url: URL,
  key: string,
  signal: AbortSignal,
): Promise<Fetched> => {
  const qs = new URLSearchParams({
    token: key,
    url: url.href,
    output: 'markdown',
    timeout: String(SCRAPEDO_TIMEOUT_MS),
  });
  const res = await callWithRetry(
    `http_fetch:scrape.do`,
    signal,
    (s) =>
      fetch(`https://api.scrape.do/?${qs}`, {
        signal: AbortSignal.any([
          s,
          AbortSignal.timeout(SCRAPEDO_TIMEOUT_MS + 5_000),
        ]),
      }),
  );
  /* its own failures (bad token, out of credits, concurrency) come back as 401/429 */
  if (res.status === 401 || res.status === 429) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`scrape.do → ${res.status}${body ? `: ${body}` : ''}`);
  }
  return { res, url, markdown: true };
};

const TAVILY_TIMEOUT_MS = 30_000;

/* tavily extract returns clean markdown; no ssrf check since it fetches server-side */
const fetchTavily = async (
  url: URL,
  key: string,
  signal: AbortSignal,
): Promise<Fetched> => {
  const res = await callWithRetry(
    `http_fetch:tavily`,
    signal,
    (s) =>
      fetch('https://api.tavily.com/extract', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          urls: [url.href],
          format: 'markdown',
          extract_depth: 'basic',
        }),
        signal: AbortSignal.any([s, AbortSignal.timeout(TAVILY_TIMEOUT_MS)]),
      }),
  );
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`tavily → ${res.status}${body ? `: ${body}` : ''}`);
  }
  const data = (await res.json()) as {
    results?: { url?: string; raw_content?: string }[];
    failed_results?: { url?: string; error?: string }[];
  };
  const result = data.results?.[0];
  if (!result?.raw_content) {
    const fail = data.failed_results?.[0];
    throw new Error(fail?.error ?? 'tavily returned no content');
  }
  return {
    res: new Response(result.raw_content, { status: 200 }),
    url: new URL(result.url ?? url.href),
    markdown: true,
  };
};

export const httpFetch: ServerTool = {
  id: 'http_fetch',
  description:
    'Fetch a public URL with GET and return its content as text (HTML is converted to plain text). ' +
    'Use it to read a page found through search or given by the user.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'absolute http(s) url' },
    },
    required: ['url'],
  },
  backends: () => [
    { id: 'direct' },
    { id: 'scrape.do', key: 'scrape.do' },
    { id: 'tavily', key: 'tavily' },
  ],
  async run(args, { signal, provider, apiKey }) {
    let start: URL;
    try {
      start = new URL(String(args.url ?? ''));
    } catch {
      throw new Error('url is not a valid absolute URL');
    }
    if (start.protocol !== 'http:' && start.protocol !== 'https:')
      throw new Error('only http(s) urls can be fetched');
    /* the picked backend may have lost its key since the grant was saved */
    let fetched: Fetched;
    if (provider === 'tavily') {
      if (!apiKey) throw new Error('tavily api key is no longer configured');
      fetched = await fetchTavily(start, apiKey, signal);
    } else if (provider === 'scrape.do') {
      if (!apiKey) throw new Error('scrape.do api key is no longer configured');
      fetched = await fetchScrapeDo(start, apiKey, signal);
    } else {
      fetched = await fetchDirect(start, signal);
    }
    const { res, url, markdown } = fetched;
    const type = res.headers.get('content-type') ?? '';
    const head = `${res.status} ${url.href}\ncontent-type: ${type || 'unknown'}\n\n`;
    if (
      !markdown &&
      !/^(text\/|application\/(json|xml|xhtml|ld\+json|javascript))/i.test(
        type,
      ) &&
      type
    ) {
      void res.body?.cancel().catch(() => {});
      return `${head}[binary content not shown]`;
    }
    const body = await readCapped(res);
    if (markdown || !/html/i.test(type)) return head + body;
    return { result: head + htmlToText(body), raw: body };
  },
};

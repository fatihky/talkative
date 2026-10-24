/*
 * tools/github — five read-only tools over the GitHub REST and GraphQL
 * APIs: repo search, file/directory fetch, issue search, PR search and
 * discussion search.
 *
 * Business logic:
 * - all five route through one 'github' backend keyed by the 'github'
 *   provider: the user's own key or the shared GITHUB_PAT env key when the
 *   site's env-key policy admits it. With neither, all five are filtered
 *   out of runs and settings reports "no key configured for github"; the
 *   composer tool bar toggles the five grants as one bulk section.
 * - REST calls pin the 2022-11-28 api version and attach the Bearer token
 *   when a key resolved (unauthenticated otherwise); every request is
 *   capped at 15s and races the run's abort signal, and an HTTP error
 *   throws "github → <status>: <body>" which invokeTool hands to the model
 *   as an error result.
 * - searches clamp limit to 1–30 (discussions 1–25, default 10), whitelist
 *   sort/order values, and issue vs PR search append type:issue / type:pr
 *   to the shared /search/issues endpoint so each returns only its kind.
 * - the model sees a compact markdown digest (names, stars, state, labels,
 *   urls); the untouched JSON response rides along as `raw` for the ui.
 * - file fetch handles every contents-api shape: an array is a directory
 *   listing, symlink/submodule entries return pointers instead of content,
 *   and a file body comes from inline base64 or — when the api omits it
 *   above 1 MB — a direct download_url fetch.
 * - file bodies are capped: a nul byte in the first 8 KB marks the file
 *   binary (content suppressed), and text is cut at 400 KB with the
 *   remaining byte count reported to the model.
 * - discussion search isn't in the REST search api — it goes through
 *   GraphQL and hard-requires a token, throwing when none resolved.
 */
import type { ServerTool } from './index';

const TIMEOUT_MS = 15_000;

const ghFetch = async (
  path: string,
  signal: AbortSignal,
  token?: string,
): Promise<{ json: unknown; raw: string }> => {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${path}`, {
    headers,
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`github → ${res.status}${body ? `: ${body}` : ''}`);
  }
  const raw = await res.text();
  return { json: JSON.parse(raw) as unknown, raw };
};

const GITHUB_BACKENDS = () => [{ id: 'github', key: 'github' }];

/* ── repo search ─────────────────────────────────────────────── */

export const githubRepoSearch: ServerTool = {
  id: 'github_repo_search',
  description:
    'Search GitHub repositories. Supports GitHub search qualifiers like "language:rust stars:>100 topic:cli". ' +
    'Returns name, owner, description, stars, language and URL.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'search query; supports GitHub qualifiers (e.g. "machine learning language:python stars:>500")',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 30,
        description: 'results to return (default 10)',
      },
      sort: {
        type: 'string',
        enum: ['stars', 'forks', 'updated', 'best-match'],
        description: 'sort order (default best-match)',
      },
    },
    required: ['query'],
  },
  backends: GITHUB_BACKENDS,
  async run(args, { signal, apiKey }) {
    const q = typeof args.query === 'string' ? args.query.trim() : '';
    if (!q) throw new Error('query is required');
    const perPage = Math.min(
      30,
      Math.max(1, Math.trunc(Number(args.limit) || 10)),
    );
    const sort =
      args.sort === 'stars' || args.sort === 'forks' || args.sort === 'updated'
        ? args.sort
        : undefined;
    const params = new URLSearchParams({ q, per_page: String(perPage) });
    if (sort) params.set('sort', sort);
    const { json, raw } = await ghFetch(
      `/search/repositories?${params}`,
      signal,
      apiKey,
    );
    const items = (json as { items?: unknown[] }).items ?? [];
    if (!items.length) return { result: 'no repositories found', raw };
    const lines = (items as Record<string, unknown>[]).map((r, i) => {
      const full = `${r.full_name}`;
      const desc = r.description
        ? `\n   ${(r.description as string).slice(0, 160)}`
        : '';
      const lang = r.language ? ` · ${r.language}` : '';
      const stars = `★ ${r.stargazers_count}`;
      return `${i + 1}. **${full}** (${stars}${lang})\n   https://github.com/${full}${desc}`;
    });
    return { result: lines.join('\n\n'), raw };
  },
};

/* ── file fetch ─────────────────────────────────────────────── */

const MAX_TEXT_BYTES = 400_000;

/* a nul byte in the head is the usual tell that a file isn't text */
const looksBinary = (buf: Buffer) => buf.subarray(0, 8_000).includes(0);

export const githubFileFetch: ServerTool = {
  id: 'github_file_fetch',
  description:
    'Fetch the contents of a file, or list the entries of a directory, in a GitHub repository. ' +
    'Give owner, repo and path, plus an optional branch, tag or commit via ref. ' +
    'Returns the decoded text of the file, or a listing for a directory.',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'repository owner (user or org)' },
      repo: { type: 'string', description: 'repository name' },
      path: {
        type: 'string',
        description:
          'path to the file or directory within the repo (empty or "/" for the root)',
      },
      ref: {
        type: 'string',
        description:
          'branch, tag or commit sha (default: the repository default branch)',
      },
    },
    required: ['owner', 'repo', 'path'],
  },
  backends: GITHUB_BACKENDS,
  async run(args, { signal, apiKey }) {
    const owner = typeof args.owner === 'string' ? args.owner.trim() : '';
    const repo = typeof args.repo === 'string' ? args.repo.trim() : '';
    if (!owner || !repo) throw new Error('owner and repo are required');
    const path =
      typeof args.path === 'string'
        ? args.path.trim().replace(/^\/+|\/+$/g, '')
        : '';
    const ref = typeof args.ref === 'string' ? args.ref.trim() : '';
    const encoded = path
      ? path.split('/').map(encodeURIComponent).join('/')
      : '';
    const qs = ref ? `?${new URLSearchParams({ ref })}` : '';
    const { json } = await ghFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encoded}${qs}`,
      signal,
      apiKey,
    );

    const where = `${owner}/${repo}${path ? `/${path}` : ''}${ref ? ` @ ${ref}` : ''}`;

    /* a directory comes back as a list of entries */
    if (Array.isArray(json)) {
      if (!json.length) return `no entries under ${where}`;
      const lines = (json as Record<string, unknown>[]).map((e) => {
        const size = typeof e.size === 'number' ? ` · ${e.size} bytes` : '';
        const suffix = e.type === 'dir' ? '/' : '';
        return `- ${e.name}${suffix} (${e.type}${size})`;
      });
      return `directory ${where} — ${json.length} entries\n${lines.join('\n')}`;
    }

    const entry = json as Record<string, unknown>;
    if (entry.type === 'symlink')
      return `symlink ${where} → ${entry.target ?? 'unknown'} (fetch the target path directly)`;
    if (entry.type === 'submodule')
      return `submodule ${where} → ${entry.submodule_git_url ?? 'unknown'}`;

    const size = typeof entry.size === 'number' ? entry.size : 0;
    const inline =
      entry.encoding === 'base64' ? (entry.content as string) : undefined;
    let buf: Buffer;
    if (inline) {
      buf = Buffer.from(inline, 'base64');
    } else if (typeof entry.download_url === 'string') {
      /* the contents api omits the body above 1 MB; download it directly */
      const tk = apiKey;
      const res = await fetch(entry.download_url, {
        headers: tk ? { authorization: `Bearer ${tk}` } : {},
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      });
      if (!res.ok) throw new Error(`github → ${res.status} fetching file body`);
      buf = Buffer.from(await res.arrayBuffer());
    } else {
      throw new Error('file has no downloadable content');
    }

    const total = size || buf.length;
    if (looksBinary(buf))
      return `${where} (${total} bytes)\n\n[binary file, contents not shown]`;
    const text = buf.subarray(0, MAX_TEXT_BYTES).toString('utf8');
    const cut =
      buf.length > MAX_TEXT_BYTES
        ? `\n\n… [truncated ${buf.length - MAX_TEXT_BYTES} bytes]`
        : '';
    return `${where} (${total} bytes)\n\n${text}${cut}`;
  },
};

/* ── issue search ────────────────────────────────────────────── */

export const githubIssueSearch: ServerTool = {
  id: 'github_issue_search',
  description:
    'Search GitHub issues across all repositories. Supports qualifiers like "repo:owner/name", ' +
    '"label:bug", "state:open", "author:user". Returns title, state, labels, author and URL.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'search query; supports GitHub qualifiers (e.g. "memory leak repo:facebook/react label:bug state:open")',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 30,
        description: 'results to return (default 10)',
      },
      sort: {
        type: 'string',
        enum: ['created', 'updated', 'comments', 'best-match'],
        description: 'sort order (default best-match)',
      },
      order: {
        type: 'string',
        enum: ['asc', 'desc'],
        description: 'sort direction (default desc)',
      },
    },
    required: ['query'],
  },
  backends: GITHUB_BACKENDS,
  async run(args, { signal, apiKey }) {
    const q = typeof args.query === 'string' ? args.query.trim() : '';
    if (!q) throw new Error('query is required');
    const perPage = Math.min(
      30,
      Math.max(1, Math.trunc(Number(args.limit) || 10)),
    );
    const sort =
      args.sort === 'created' ||
      args.sort === 'updated' ||
      args.sort === 'comments'
        ? args.sort
        : undefined;
    const order = args.order === 'asc' ? 'asc' : 'desc';
    const params = new URLSearchParams({
      q: `${q} type:issue`,
      per_page: String(perPage),
      order,
    });
    if (sort) params.set('sort', sort);
    const { json, raw } = await ghFetch(
      `/search/issues?${params}`,
      signal,
      apiKey,
    );
    const items = (json as { items?: unknown[] }).items ?? [];
    if (!items.length) return { result: 'no issues found', raw };
    const lines = (items as Record<string, unknown>[]).map((item, i) => {
      const title = item.title as string;
      const url = item.html_url as string;
      const state = item.state as string;
      const user = (item.user as Record<string, unknown>)?.login ?? 'unknown';
      const labels = ((item.labels as Record<string, unknown>[]) ?? [])
        .map((l) => l.name)
        .join(', ');
      const meta = [state, labels && `labels: ${labels}`]
        .filter(Boolean)
        .join(' · ');
      return `${i + 1}. **${title}**\n   by ${user} · ${meta}\n   ${url}`;
    });
    return { result: lines.join('\n\n'), raw };
  },
};

/* ── pr search ───────────────────────────────────────────────── */

export const githubPrSearch: ServerTool = {
  id: 'github_pr_search',
  description:
    'Search GitHub pull requests across all repositories. Supports qualifiers like "repo:owner/name", ' +
    '"is:merged", "review:approved", "author:user". Returns title, state, author and URL.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'search query; supports GitHub qualifiers (e.g. "fix typo repo:vercel/next.js is:merged")',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 30,
        description: 'results to return (default 10)',
      },
      sort: {
        type: 'string',
        enum: ['created', 'updated', 'comments', 'best-match'],
        description: 'sort order (default best-match)',
      },
      order: {
        type: 'string',
        enum: ['asc', 'desc'],
        description: 'sort direction (default desc)',
      },
    },
    required: ['query'],
  },
  backends: GITHUB_BACKENDS,
  async run(args, { signal, apiKey }) {
    const q = typeof args.query === 'string' ? args.query.trim() : '';
    if (!q) throw new Error('query is required');
    const perPage = Math.min(
      30,
      Math.max(1, Math.trunc(Number(args.limit) || 10)),
    );
    const sort =
      args.sort === 'created' ||
      args.sort === 'updated' ||
      args.sort === 'comments'
        ? args.sort
        : undefined;
    const order = args.order === 'asc' ? 'asc' : 'desc';
    const params = new URLSearchParams({
      q: `${q} type:pr`,
      per_page: String(perPage),
      order,
    });
    if (sort) params.set('sort', sort);
    const { json, raw } = await ghFetch(
      `/search/issues?${params}`,
      signal,
      apiKey,
    );
    const items = (json as { items?: unknown[] }).items ?? [];
    if (!items.length) return { result: 'no pull requests found', raw };
    const lines = (items as Record<string, unknown>[]).map((item, i) => {
      const title = item.title as string;
      const url = item.html_url as string;
      const state = item.state as string;
      const merged =
        item.pull_request &&
        (item.pull_request as Record<string, unknown>).merged_at;
      const status = merged ? 'merged' : state;
      const user = (item.user as Record<string, unknown>)?.login ?? 'unknown';
      return `${i + 1}. **${title}**\n   by ${user} · ${status}\n   ${url}`;
    });
    return { result: lines.join('\n\n'), raw };
  },
};

/* ── discussion search ───────────────────────────────────────── */

export const githubDiscussionSearch: ServerTool = {
  id: 'github_discussion_search',
  description:
    'Search GitHub discussions across all repositories using the GraphQL API. ' +
    'Returns title, category, author, upvotes and URL. Discussions are community Q&A, ' +
    'distinct from issues.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'search query (e.g. "server components" or "repo:vercel/next.js app router migration")',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 25,
        description: 'results to return (default 10)',
      },
    },
    required: ['query'],
  },
  backends: GITHUB_BACKENDS,
  async run(args, { signal, apiKey }) {
    const q = typeof args.query === 'string' ? args.query.trim() : '';
    if (!q) throw new Error('query is required');
    const first = Math.min(
      25,
      Math.max(1, Math.trunc(Number(args.limit) || 10)),
    );
    /* discussions aren't in the rest search api; graphql only */
    const tk = apiKey;
    if (!tk)
      throw new Error('a GitHub token is required for discussion search');
    const query = `
      query($q: String!, $first: Int!) {
        search(query: $q, type: DISCUSSION, first: $first) {
          nodes {
            ... on Discussion {
              title
              url
              createdAt
              upvoteCount
              author { login }
              category { name }
              repository { nameWithOwner }
            }
          }
        }
      }`;
    const res = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tk}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables: { q, first } }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(
        `github graphql → ${res.status}${body ? `: ${body}` : ''}`,
      );
    }
    const raw = await res.text();
    const json = JSON.parse(raw) as {
      data?: { search?: { nodes?: unknown[] } };
      errors?: unknown[];
    };
    if (json.errors) {
      const msg = (json.errors as Record<string, unknown>[])
        .map((e) => e.message)
        .join('; ');
      throw new Error(`github graphql: ${msg}`);
    }
    const nodes = json.data?.search?.nodes ?? [];
    if (!nodes.length) return { result: 'no discussions found', raw };
    const lines = (nodes as Record<string, unknown>[]).map((d, i) => {
      const title = d.title as string;
      const url = d.url as string;
      const repo = (d.repository as Record<string, unknown>)?.nameWithOwner;
      const category = (d.category as Record<string, unknown>)?.name;
      const author = (d.author as Record<string, unknown>)?.login ?? 'unknown';
      const upvotes = d.upvoteCount ?? 0;
      const meta = [category && `📁 ${category}`, `▲ ${upvotes}`]
        .filter(Boolean)
        .join(' · ');
      return `${i + 1}. **${title}**\n   ${repo} · by ${author} · ${meta}\n   ${url}`;
    });
    return { result: lines.join('\n\n'), raw };
  },
};

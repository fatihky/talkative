/*
 * ToolCallView — collapsed strip for one tool call inside a reply.
 *
 * Business logic:
 * - the summary shows the tool name, a compact one-line args preview,
 *   and the status: a spinner while running, else done/failed with the
 *   duration.
 * - expanding reveals pretty-printed arguments, the result (red on
 *   error), and the raw provider response when present.
 * - a failed call offers retry only while the chat is idle (onRetry is
 *   unset during generation): it reruns the call and continues the
 *   reply as a new branch, staying with the model that started it.
 * - the retry button suppresses the default so the click doesn't also
 *   toggle the details.
 */
'use client';

import { I } from '../../lib/icons';
import { Tip } from '../../lib/popover';
import type { ToolCall } from '../../types';

/* compact one-line view of the arguments, e.g. `query: "rust async"` */
const argsPreview = (raw: string) => {
  try {
    const v = JSON.parse(raw || '{}') as Record<string, unknown>;
    return Object.entries(v)
      .map(([k, x]) => `${k}: ${JSON.stringify(x)}`)
      .join(', ');
  } catch {
    return raw;
  }
};

const prettyArgs = (raw: string) => {
  try {
    return JSON.stringify(JSON.parse(raw || '{}'), null, 2);
  } catch {
    return raw;
  }
};

/* a search hit with a title, target and blurb, uniform across backends */
type Hit = { title: string; url: string; snippet: string };

/*
 * pull hits out of a web_search raw response. the upstream shapes differ by
 * backend (tavily/exa `results`, serper/serpapi `organic_results`, …), so
 * this walks the known container keys and reads the common field names.
 */
const parseSearchHits = (raw: string | undefined): Hit[] => {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as unknown;
    const root = data as Record<string, unknown>;
    const containers = ['results', 'organic_results', 'data'];
    for (const key of containers) {
      const v = root[key];
      if (!Array.isArray(v)) continue;
      const hits = v
        .map((r) => {
          if (typeof r !== 'object' || r === null) return null;
          const o = r as Record<string, unknown>;
          const title = o.title ?? o.name;
          const url = o.url ?? o.link;
          const snippet =
            o.snippet ?? o.content ?? o.description ?? o.raw_text;
          if (typeof title !== 'string' || typeof url !== 'string') return null;
          return {
            title,
            url,
            snippet: typeof snippet === 'string' ? snippet : '',
          };
        })
        .filter((h): h is Hit => h !== null);
      if (hits.length) return hits;
    }
  } catch {
    /* fall through to the plain result text */
  }
  return [];
};

/* clickable search results with the untouched response tucked behind a disclosure */
function SearchResults({
  raw,
  result,
  err,
}: {
  raw: string | undefined;
  result: string | undefined;
  err: boolean;
}) {
  const hits = parseSearchHits(raw);
  const showRaw = raw !== undefined || err;
  return (
    <>
      <div className="sec-label">search results</div>
      {err ? (
        <div className="num break-words text-[11px] text-[var(--danger)]">
          {result ?? 'search failed'}
        </div>
      ) : hits.length ? (
        <ol className="flex flex-col gap-1.5">
          {hits.map((h) => (
            <li key={h.url} className="flex flex-col gap-0.5">
              <a
                href={h.url}
                target="_blank"
                rel="noreferrer"
                className="line-clamp-1 font-medium text-[var(--accent)] hover:underline"
              >
                {h.title}
              </a>
              <span className="num line-clamp-1 text-[10px] muted">
                {h.url}
              </span>
              {h.snippet && (
                <span className="line-clamp-2 text-[11px]">{h.snippet}</span>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <pre className="num scroll-thin max-h-60 overflow-auto whitespace-pre-wrap break-words text-[11px]">
          {result}
        </pre>
      )}
      {showRaw && (
        <details className="group">
          <summary className="sec-label flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
            <I n="chevron-right" s={9} className="transition-transform group-open:rotate-90" />
            inspect raw results
          </summary>
          <pre className="num scroll-thin mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words text-[11px]">
            {raw}
          </pre>
        </details>
      )}
    </>
  );
}

export function ToolCallView({
  c,
  onRetry,
}: {
  c: ToolCall;
  onRetry?: ((callId: string) => void) | undefined;
}) {
  return (
    <details className="group rounded-[6px] border border-[var(--border)] bg-[var(--panel)] text-[12px]">
      <summary className="flex h-7 cursor-pointer list-none items-center gap-1.5 px-2 [&::-webkit-details-marker]:hidden">
        <I n="wrench" s={11} className="shrink-0 muted" />
        <span className="shrink-0 font-medium">{c.name}</span>
        <span className="num min-w-0 flex-1 truncate muted">
          {argsPreview(c.args)}
        </span>
        {c.status === 'running' ? (
          <span
            role="status"
            aria-label="running"
            className="block size-3 shrink-0 animate-spin rounded-full border-2 border-[var(--border-strong)] border-t-transparent"
          />
        ) : (
          <span
            className={`num shrink-0 text-[11px] ${c.status === 'error' ? 'text-[var(--danger)]' : 'muted'}`}
          >
            {c.status === 'error' ? 'failed' : 'done'}
            {c.ms !== undefined ? ` · ${(c.ms / 1000).toFixed(1)}s` : ''}
          </span>
        )}
        {c.status === 'error' && onRetry && (
          <Tip
            label="Retry — reruns the call and continues as a new branch"
            side="bottom"
          >
            <button
              type="button"
              aria-label="Retry tool call"
              className="ctl-icon size-5 shrink-0 border-transparent bg-transparent text-[var(--text-2)] hover:bg-[var(--sunken)]"
              onClick={(e) => {
                /* a click inside <summary> would also toggle the details */
                e.preventDefault();
                onRetry(c.id);
              }}
            >
              <I n="rotate-cw" s={10} />
            </button>
          </Tip>
        )}
        <I
          n="chevron-down"
          s={10}
          className="shrink-0 opacity-60 transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="flex flex-col gap-1.5 border-t border-[var(--border)] px-2 py-1.5">
        <div className="sec-label">arguments</div>
        <pre className="num scroll-thin max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px]">
          {prettyArgs(c.args)}
        </pre>
        {c.name === 'web_search' ? (
          <SearchResults raw={c.raw} result={c.result} err={c.status === 'error'} />
        ) : (
          <>
            {c.result !== undefined && (
              <>
                <div className="sec-label">result</div>
                <pre
                  className={`num scroll-thin max-h-60 overflow-auto whitespace-pre-wrap break-words text-[11px] ${c.status === 'error' ? 'text-[var(--danger)]' : ''}`}
                >
                  {c.result}
                </pre>
              </>
            )}
            {c.raw !== undefined && (
              <>
                <div className="sec-label">raw response</div>
                <pre className="num scroll-thin max-h-60 overflow-auto whitespace-pre-wrap break-words text-[11px]">
                  {c.raw}
                </pre>
              </>
            )}
          </>
        )}
      </div>
    </details>
  );
}

/*
 * ToolCallView — a tool call rendered as the handoff's "tool card".
 *
 * The clean-layout handoff models a call as a `.tool-card`: a bordered
 * card whose head carries an icon, the tool name in mono, a one-line
 * quoted detail (the first string argument, for search-style tools the
 * query), a status pill, and a chevron; the body collapses by default
 * and opens a one-line result summary.
 *
 * Business logic:
 * - the head shows the tool's glyph, its name, a quoted detail preview,
 *   and a Pill: `RUNNING` (rippling) while in flight, else the handoff's
 *   resolved labels — `DONE · Ns`, `FAILED`, or a bespoke label for
 *   `save_memory` ("SAVED").
 * - expanding reveals the result summary: search tools list the source
 *   count and titles, everything else shows the pretty-printed arguments
 *   and result/raw response.
 * - a failed call offers retry only while the chat is idle (onRetry is
 *   unset during generation): it confirms via the app modal (rest of the
 *   branch will be re-generated), then reruns the call and continues the
 *   reply as a new branch. The retry button suppresses its own click so
 *   the head doesn't also toggle.
 */
'use client';

import { useState } from 'react';
import { I } from '../../lib/icons';
import { actions } from '../../stores';
import type { ToolCall } from '../../types';

/* quoted one-line view of the arguments: the first string value, else a
   key:value list. search tools prefer the query so the card reads like
   the handoff's '"graphql rate limiting best practices 2026"'. */
const argsPreview = (name: string, raw: string) => {
  try {
    const v = JSON.parse(raw || '{}') as Record<string, unknown>;
    const entries = Object.entries(v);
    const queryKeys = ['query', 'q', 'search', 'prompt', 'term', 'text'];
    const firstString = entries.find(([, x]) => typeof x === 'string');
    const query =
      entries.find(([k, x]) => queryKeys.includes(k) && typeof x === 'string')
        ?.[1] ?? firstString?.[1];
    if (typeof query === 'string' && query.trim())
      return `"${query.replace(/^"|"$/g, '')}"`;
    return entries.map(([k, x]) => `${k}: ${JSON.stringify(x)}`).join(', ');
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

/* the glyph shown in the card head, per tool kind */
const TOOL_ICON: Record<string, string> = {
  web_search: 'globe',
  github_search: 'branch',
  save_memory: 'brain',
  memory: 'brain',
  ask_user: 'help',
  read_file: 'file',
  write_file: 'file',
  run_command: 'monitor',
  code_exec: 'monitor',
  shell: 'monitor',
};

/* the status Pill for a call, matching the handoff's `DONE · 1.2s` pills */
function StatusPill({ c }: { c: ToolCall }) {
  if (c.status === 'running') {
    return (
      <span className="pill a">
        <span className="pulse" aria-hidden="true" />
        RUNNING
      </span>
    );
  }
  if (c.status === 'error') {
    return <span className="pill d">FAILED</span>;
  }
  if (c.name === 'save_memory' || c.name === 'memory') {
    return <span className="pill s">SAVED</span>;
  }
  return (
    <span className={`pill s`}>
      {c.status === 'done'
        ? `DONE${c.ms !== undefined ? ` · ${(c.ms / 1000).toFixed(1)}s` : ''}`
        : 'DONE'}
    </span>
  );
}

/* one-line body summary for search tools; non-search cards carry their
   arguments/result instead when opened */
export function ToolCallView({
  c,
  onRetry,
}: {
  c: ToolCall;
  onRetry?: ((callId: string) => void) | undefined;
}) {
  /* collapsed by default; a resolved head stays closed and non-hover */
  const [open, setOpen] = useState(false);
  const resolved = c.status !== 'running';

  return (
    <div
      className={`tool-card ${open ? '' : 'collapsed'} ${resolved ? 'resolved' : ''}`}
    >
      <div
        className="tool-card-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        <I n={TOOL_ICON[c.name] ?? 'wrench'} s={14} />
        <span className="tool-name">{c.name}</span>
        <span className="tool-detail">{argsPreview(c.name, c.args)}</span>
        <StatusPill c={c} />
        {c.status === 'error' && onRetry && (
          <button
            type="button"
            aria-label="Retry tool call"
            className="icon-only"
            onClick={async (e) => {
              /* a click inside the head must not also toggle it */
              e.preventDefault();
              e.stopPropagation();
              const ok = await actions.confirm({
                title: 'Retry this tool call?',
                body: 'Retrying reruns this failed call and continues the reply from here. Everything after it on this branch will be re-generated.',
                confirmLabel: 'Retry',
                danger: true,
              });
              if (ok) onRetry(c.id);
            }}
          >
            <I n="rotate-cw" s={12} />
          </button>
        )}
        <I n="chevron-down" s={14} className="chev" />
      </div>

      {open && (
        <div className="tool-card-body">
          {c.name === 'web_search' ? (
            <SearchResults raw={c.raw} result={c.result} err={c.status === 'error'} />
          ) : (
            <>
              <div className="sec-label">arguments</div>
              <pre className="num scroll-thin mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-[11px]">
                {prettyArgs(c.args)}
              </pre>
              {c.result !== undefined && (
                <>
                  <div className="sec-label mt-1.5">result</div>
                  <pre
                    className={`num scroll-thin max-h-60 overflow-auto whitespace-pre-wrap break-words text-[11px] ${c.status === 'error' ? 'text-[var(--danger)]' : ''}`}
                  >
                    {c.result}
                  </pre>
                </>
              )}
              {c.raw !== undefined && (
                <>
                  <div className="sec-label mt-1.5">raw response</div>
                  <pre className="num scroll-thin max-h-60 overflow-auto whitespace-pre-wrap break-words text-[11px]">
                    {c.raw}
                  </pre>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* clickable search results with the untouched response behind a disclosure */
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

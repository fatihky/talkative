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
      </div>
    </details>
  );
}

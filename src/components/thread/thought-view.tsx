/*
 * ThoughtView — collapsible reasoning block for one model step, styled
 * to the clean-layout card vocabulary (same frame as the tool card).
 *
 * Business logic:
 * - collapsed by default; expanding reveals the raw thinking text.
 * - while live (reply still streaming, no duration reported) it shows a
 *   pulsing "Thinking…" pill; once settled it reports the duration and
 *   drops the pill, so no label says "reasoning" after thinking ended.
 * - thoughts are persisted on the message and replay in place within
 *   the reply on reload.
 */
'use client';

import { I } from '../../lib/icons';
import type { Thought } from '../../types';

/* collapsed by default; the summary only says whether thinking is still in progress */
export function ThoughtView({ t, live }: { t: Thought; live: boolean }) {
  return (
    <details className="tool-card group my-0">
      <summary className="flex h-9 cursor-pointer list-none items-center gap-2 px-3 [&::-webkit-details-marker]:hidden">
        <I n="brain" s={13} className={`shrink-0 muted ${live ? 'animate-pulse' : ''}`} />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
          {live
            ? 'Thinking…'
            : t.ms !== undefined
              ? `Thought for ${(t.ms / 1000).toFixed(1)}s`
              : 'Thoughts'}
        </span>
        {live && (
          <span className="pill a">
            <span className="pulse" aria-hidden="true" />
            THINKING
          </span>
        )}
        <I
          n="chevron-down"
          s={13}
          className="shrink-0 -rotate-90 opacity-60 transition-transform group-open:rotate-0"
        />
      </summary>
      <div className="scroll-thin max-h-80 overflow-auto border-t border-[var(--border)] px-3 py-1.5 whitespace-pre-wrap break-words leading-[1.5] text-[12px] muted">
        {t.text.trim()}
      </div>
    </details>
  );
}

/*
 * ThoughtView — collapsible reasoning block for one model step.
 *
 * Business logic:
 * - collapsed by default; expanding reveals the raw thinking text.
 * - while live (reply still streaming, no duration reported) it shows a
 *   pulsing "Thinking…"; once settled it reports "Thought for X.Xs",
 *   so the indicator can't hang after the run ends.
 * - thoughts are persisted on the message and replay in place within
 *   the reply on reload.
 */
'use client';

import { I } from '../../lib/icons';
import type { Thought } from '../../types';

/* collapsed by default; the summary only says whether thinking is still in progress */
export function ThoughtView({ t, live }: { t: Thought; live: boolean }) {
  return (
    <details className="group my-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--panel)] text-[12px] whitespace-normal">
      <summary className="flex h-7 cursor-pointer list-none items-center gap-1.5 px-2 [&::-webkit-details-marker]:hidden">
        <I
          n="brain"
          s={11}
          className={`shrink-0 muted ${live ? 'animate-pulse' : ''}`}
        />
        <span className="min-w-0 flex-1 truncate font-medium">
          {live
            ? 'Thinking…'
            : t.ms !== undefined
              ? `Thought for ${(t.ms / 1000).toFixed(1)}s`
              : 'Thoughts'}
        </span>
        <I
          n="chevron-down"
          s={10}
          className="shrink-0 opacity-60 transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="scroll-thin max-h-80 overflow-auto border-t border-[var(--border)] px-2 py-1.5 whitespace-pre-wrap break-words leading-[1.5] muted">
        {t.text.trim()}
      </div>
    </details>
  );
}

/*
 * SuggestionChips — home prompt starters from the suggestions feed.
 *
 * Business logic:
 * - S9: renders nothing at all when there are no suggestions, collapsing
 *   the gap.
 * - Shows the first six chips inline; the rest hide behind a "+N" button
 *   that opens a popover list.
 * - Clicking a chip inserts its prompt into the composer draft (it does
 *   not send); picking from the popover also closes it.
 * - On mobile the row becomes a horizontal snap scroller instead of
 *   wrapping.
 */
'use client';

import { useRef, useState } from 'react';
import { I } from '../../lib/icons';
import { Popover } from '../../lib/popover';
import { actions, useChatsStore } from '../../stores';
import type { Suggestion } from '../../types';

function SuggestionChip({ s }: { s: Suggestion }) {
  return (
    <button
      type="button"
      onClick={() => actions.insertPrompt(s.prompt)}
      className="ctl inline-flex h-8 max-w-[280px] shrink-0 items-center gap-1.5 text-[13px] font-normal"
      title={s.prompt}
    >
      {s.icon && <I n={s.icon} s={14} className="shrink-0 muted" />}
      <span className="truncate">{s.label}</span>
    </button>
  );
}

export function SuggestionChips() {
  const items = useChatsStore((s) => s.suggestions);
  const shown = items.slice(0, 6);
  const rest = items.slice(6);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const [more, setMore] = useState(false);
  if (items.length === 0) return null; /* S9: hide entirely, collapse the gap */
  return (
    // biome-ignore lint/a11y/useSemanticElements: fieldset's min-content sizing breaks the horizontal scroller
    <div
      className="mt-6 flex flex-wrap gap-2 max-md:w-full max-md:flex-nowrap max-md:overflow-x-auto max-md:snap-x max-md:pb-1"
      role="group"
      aria-label="Suggestions"
    >
      {shown.map((s) => (
        <SuggestionChip key={s.id} s={s} />
      ))}
      {rest.length > 0 && (
        <>
          <button
            ref={anchor}
            type="button"
            className="ctl h-8 w-9 shrink-0 text-[12px] muted"
            aria-expanded={more}
            aria-label={`Show ${rest.length} more suggestions`}
            onClick={() => setMore((v) => !v)}
          >
            +{rest.length}
          </button>
          <Popover
            open={more}
            anchor={anchor}
            onClose={() => setMore(false)}
            placement="top-start"
            width={260}
            z={40}
          >
            <div className="flex flex-col py-1">
              {rest.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className="flex items-center gap-1.5 px-3 py-1.5 text-left text-[13px] hover:bg-[var(--sunken)]"
                  onClick={() => {
                    actions.insertPrompt(s.prompt);
                    setMore(false);
                  }}
                >
                  {s.icon && <I n={s.icon} s={13} className="muted shrink-0" />}
                  <span className="truncate">{s.label}</span>
                </button>
              ))}
            </div>
          </Popover>
        </>
      )}
    </div>
  );
}

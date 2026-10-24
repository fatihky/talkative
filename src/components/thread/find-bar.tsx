/*
 * FindBar — find-in-chat over the branch on screen (mod+F / Ctrl+F).
 *
 * Business logic:
 * - matches the typed text as one case-insensitive literal (not search
 *   syntax) in the rendered thread, so it only sees the visible branch;
 *   button labels and message meta are skipped.
 * - matches repaint through CSS highlights (lib/search.tsx) and are
 *   recomputed, debounced, whenever the thread re-renders (a streaming
 *   reply, a branch switch), keeping the current index where it still fits.
 * - Enter / ↓ goes to the next match and Shift+Enter / ↑ to the previous,
 *   wrapping around; each move centers the match in the scroller and calls
 *   onNavigate so the thread stops following the bottom.
 * - Esc or ✕ closes and clears every highlight; the key event stops here so
 *   the shell's Esc doesn't also close a panel.
 */
'use client';

import { type RefObject, useEffect, useRef, useState } from 'react';
import { I } from '../../lib/icons';
import { Tip } from '../../lib/popover';
import { findRanges, paintHighlights } from '../../lib/search';

export function FindBar({
  rootRef,
  scrollRef,
  version,
  onClose,
  onNavigate,
  focusKey,
}: {
  rootRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
  /* changes whenever the rendered thread does, so matches are recomputed */
  version: unknown;
  onClose: () => void;
  onNavigate: () => void;
  /* bumped by the shortcut while already open, to refocus the input */
  focusKey: number;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [q, setQ] = useState('');
  const [ranges, setRanges] = useState<Range[]>([]);
  const [idx, setIdx] = useState(0);
  /* the needle the current ranges were found for; a new one jumps to its first match */
  const lastNeedle = useRef('');

  // biome-ignore lint/correctness/useExhaustiveDependencies: refocus on every shortcut press
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusKey]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: version stands in for the thread's DOM
  useEffect(() => {
    const t = setTimeout(() => {
      const root = rootRef.current;
      const needle = q.trim();
      const next = root && needle ? findRanges(root, [needle]) : [];
      setRanges(next);
      if (needle !== lastNeedle.current) {
        lastNeedle.current = needle;
        setIdx(0);
        if (next[0]) reveal(next[0]);
      } else setIdx((i) => (i < next.length ? i : 0));
    }, 120);
    return () => clearTimeout(t);
  }, [q, version]);

  useEffect(() => {
    paintHighlights(ranges, ranges[idx]);
  }, [ranges, idx]);

  /* clear the paint when the bar goes away */
  useEffect(() => () => paintHighlights([]), []);

  const reveal = (r: Range | undefined) => {
    const el = scrollRef.current;
    if (!r || !el) return;
    onNavigate();
    const box = r.getBoundingClientRect();
    const frame = el.getBoundingClientRect();
    el.scrollTo({
      top: el.scrollTop + box.top - frame.top - frame.height / 2,
      behavior: 'smooth',
    });
  };

  const step = (d: 1 | -1) => {
    if (!ranges.length) return;
    const i = (idx + d + ranges.length) % ranges.length;
    setIdx(i);
    reveal(ranges[i]);
  };

  return (
    <div className="sticky top-0 z-10 -mt-2 flex justify-end pt-1" data-no-find>
      <div className="pop flex w-full max-w-[360px] items-center gap-1.5 px-2 py-1">
        <I n="search" s={13} className="muted shrink-0" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (
              e.key === 'Enter' ||
              e.key === 'ArrowDown' ||
              e.key === 'ArrowUp'
            ) {
              e.preventDefault();
              step(
                e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)
                  ? -1
                  : 1,
              );
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
          placeholder="Find in this branch"
          aria-label="Find in chat"
          className="h-7 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--text-3)]"
        />
        <span className="num shrink-0 text-[11px] muted" aria-live="polite">
          {q.trim() ? `${ranges.length ? idx + 1 : 0}/${ranges.length}` : ''}
        </span>
        <Tip label="Previous match" side="bottom">
          <button
            type="button"
            aria-label="Previous match"
            disabled={!ranges.length}
            onClick={() => step(-1)}
            className="ctl-icon size-6 shrink-0 border-transparent bg-transparent disabled:opacity-40"
          >
            <I n="chevron-left" s={12} className="rotate-90" />
          </button>
        </Tip>
        <Tip label="Next match" side="bottom">
          <button
            type="button"
            aria-label="Next match"
            disabled={!ranges.length}
            onClick={() => step(1)}
            className="ctl-icon size-6 shrink-0 border-transparent bg-transparent disabled:opacity-40"
          >
            <I n="chevron-right" s={12} className="rotate-90" />
          </button>
        </Tip>
        <Tip label="Close" side="bottom">
          <button
            type="button"
            aria-label="Close find"
            onClick={onClose}
            className="ctl-icon size-6 shrink-0 border-transparent bg-transparent"
          >
            <I n="x" s={11} />
          </button>
        </Tip>
      </div>
    </div>
  );
}

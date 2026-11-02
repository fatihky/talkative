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
 * - a match inside a collapsed reasoning/tool card is invisible to the
 *   browser: cards holding one are opened as the needle is typed, so their
 *   hits are real ranges; anything still closed is painted through a stand-in
 *   on the card's head (lib/search.tsx) and closes again once no match of the
 *   needle is inside it.
 * - the thread owns the paint: it keeps a search result's own words lit and
 *   shows only the bar's focused match as the current one, so the bar hands it
 *   that match (onCurrent) instead of painting over it.
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
import { findRanges, openHiddenHits } from '../../lib/search';

export function FindBar({
  rootRef,
  scrollRef,
  version,
  onClose,
  onNavigate,
  focusKey,
  onCurrent,
}: {
  rootRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
  /* changes whenever the rendered thread does, so matches are recomputed */
  version: unknown;
  onClose: () => void;
  onNavigate: () => void;
  /* bumped by the shortcut while already open, to refocus the input */
  focusKey: number;
  /* the match being centered, for the thread to paint alongside its hit */
  onCurrent: (r: Range | null) => void;
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

  /* the matches read off `root`, keeping the current one when it still fits;
     `pick` also moves the focus there (a new needle always does) */
  const read = (pick: number | null) => {
    const root = rootRef.current;
    const needle = q.trim();
    if (!root || !needle) {
      setRanges([]);
      onCurrent(null);
      return;
    }
    /* cards opened for the previous needle may close again; opening the ones
       the new needle lands in makes their hits real ranges, not stand-ins */
    openHiddenHits(root, [needle]);
    const next = findRanges(root, [needle]);
    setRanges(next);
    const i = pick ?? (idx < next.length ? idx : 0);
    setIdx(i);
    onCurrent(next[i] ?? null);
    const r = next[i];
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: version stands in for the thread's DOM
  useEffect(() => {
    const t = setTimeout(() => {
      read(q.trim() !== lastNeedle.current ? 0 : null);
      lastNeedle.current = q.trim();
    }, 120);
    return () => clearTimeout(t);
  }, [q, version]);

  /* the thread paints the hit's terms plus this match; a card holding a hit is
     opened with it, and one that stays collapsed is painted through its head */
  // biome-ignore lint/correctness/useExhaustiveDependencies: the DOM the ranges were read off stands in for the paint
  useEffect(() => {
    const r = ranges[idx];
    if (!r) return;
    const root = rootRef.current;
    if (root) openHiddenHits(root, [q.trim()]);
    onCurrent(r);
  }, [ranges, idx]);

  /* drop the focused match when the bar goes away; the thread's own hit stays lit */
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on unmount
  useEffect(() => () => onCurrent(null), []);

  const step = (d: 1 | -1) => {
    if (!ranges.length) return;
    read((idx + d + ranges.length) % ranges.length);
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

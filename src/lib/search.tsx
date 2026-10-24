/*
 * search — client helpers shared by the palette, the /search page and the
 * thread's find bar.
 *
 * Business logic:
 * - MARK_START/MARK_END are private-use characters the server wraps around
 *   matches in a snippet (both sides import them from search-marks.ts); Marked
 *   splits on them and renders <mark>, so a snippet is never parsed as html;
 *   with `lead` it drops all but a few words before the first match, so a
 *   row clipped to one line (the palette) still shows the hit.
 * - queryTerms mirrors the server's tokenizing (letters and digits, minus
 *   `or` and -excluded words) so in-thread highlights light up the same
 *   words the search matched — as prefixes, like the tsquery does.
 * - findRanges walks the text nodes under a root and returns a Range per
 *   case-insensitive occurrence of any term, in document order, skipping
 *   nodes inside buttons and elements marked data-no-find (message meta).
 * - paintHighlights uses the CSS Custom Highlight API (`search-hit` for every
 *   match, `search-current` for the focused one) so rendered markdown is
 *   never mutated; where the API is missing it paints nothing and only the
 *   scroll-to-match still works.
 */
'use client';

import { MARK_END, MARK_START } from './search-marks';

/* keeps at most `lead` chars (cut at a word start) before the first match, so a
   truncated one-line row still shows the hit instead of clipping it */
const trimLead = (text: string, lead: number) => {
  const at = text.indexOf(MARK_START);
  if (at <= lead) return text;
  const from = at - lead;
  const space = text.indexOf(' ', from);
  const start = space >= 0 && space < at ? space + 1 : from;
  return `…${text.slice(start)}`;
};

/** a server snippet with its marked matches rendered as <mark>; `lead` trims text before the first */
export function Marked({ text, lead }: { text: string; lead?: number }) {
  const parts: { t: string; hit: boolean }[] = [];
  let rest = lead === undefined ? text : trimLead(text, lead);
  while (rest) {
    const a = rest.indexOf(MARK_START);
    if (a < 0) {
      parts.push({ t: rest, hit: false });
      break;
    }
    const b = rest.indexOf(MARK_END, a);
    if (a > 0) parts.push({ t: rest.slice(0, a), hit: false });
    parts.push({ t: rest.slice(a + 1, b < 0 ? undefined : b), hit: true });
    rest = b < 0 ? '' : rest.slice(b + 1);
  }
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
          <mark key={i} className="search-mark">
            {p.t}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts are positional
          <span key={i}>{p.t}</span>
        ),
      )}
    </>
  );
}

/** the positive words of a query, lowercased, as the server matches them */
export const queryTerms = (q: string): string[] => {
  const out: string[] = [];
  for (const m of q.matchAll(/(-?)"([^"]*)"?|(\S+)/g)) {
    const raw = m[2] ?? m[3] ?? '';
    if (m[1] === '-' || raw.startsWith('-') || raw.toLowerCase() === 'or')
      continue;
    out.push(...(raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []));
  }
  return [...new Set(out)].filter(Boolean);
};

/** every occurrence of any term under `root`, in document order */
export const findRanges = (root: HTMLElement, terms: string[]): Range[] => {
  const ts = terms.map((t) => t.toLowerCase()).filter(Boolean);
  if (!ts.length) return [];
  const out: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest('[data-no-find], button')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.nodeValue ?? '').toLowerCase();
    if (!text.trim()) continue;
    const found: [number, number][] = [];
    for (const t of ts)
      for (let i = text.indexOf(t); i >= 0; i = text.indexOf(t, i + t.length))
        found.push([i, i + t.length]);
    found.sort((a, b) => a[0] - b[0]);
    let end = -1;
    for (const [a, b] of found) {
      if (a < end) continue;
      const r = document.createRange();
      r.setStart(n, a);
      r.setEnd(n, b);
      out.push(r);
      end = b;
    }
  }
  return out;
};

type HighlightRegistry = {
  set: (name: string, h: unknown) => void;
  delete: (name: string) => void;
};
const registry = (): HighlightRegistry | null => {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const H = (globalThis as { Highlight?: unknown }).Highlight;
  return css?.highlights && H ? css.highlights : null;
};

/** paints `ranges` as search hits and `current` as the focused one; empty clears */
export const paintHighlights = (ranges: Range[], current?: Range) => {
  const reg = registry();
  if (!reg) return;
  const H = (
    globalThis as unknown as { Highlight: new (...r: Range[]) => unknown }
  ).Highlight;
  if (!ranges.length) {
    reg.delete('search-hit');
    reg.delete('search-current');
    return;
  }
  reg.set('search-hit', new H(...ranges));
  if (current) reg.set('search-current', new H(current));
  else reg.delete('search-current');
};

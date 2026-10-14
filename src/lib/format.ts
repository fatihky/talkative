/*
 * format — the client's display formatting: counts, money, bytes, times.
 *
 * Business logic:
 * - Presentation only, used by components and stores; the server formats
 *   nothing here. Everything is pure except that the date helpers read the
 *   browser locale, and timeAgo/recencyGroup take an injectable `now` so a
 *   whole list groups consistently within one render.
 * - kfmt abbreviates counts (1.2k, 3.4M) and drops a trailing ".0"; ctxFmt
 *   shows a context window in thousands, or an em dash when unknown.
 * - $fmt widens precision as the cost shrinks — 6 decimals under $0.0001,
 *   4 under $0.01, 2 above, and exactly $0.00 for zero — so a single
 *   message's cost stays visible instead of rounding away.
 * - bytesFmt (attachments) and humanBytes (model sizes, which local runtimes
 *   report in bytes) both step by 1000, not 1024.
 * - recencyGroup returns the sidebar's section names: TODAY and YESTERDAY
 *   are cut at local midnight, the 7- and 30-day buckets roll back from
 *   `now`.
 * - GROSS_TOKENS (length / 4, rounded up) is the only client-side token
 *   estimate; the composer's context and cost meters are built on it, so
 *   they are deliberately rough rather than tokenizer-accurate.
 * - modKey picks ⌘ vs Ctrl from navigator.platform/userAgent and is what
 *   boot stores as the modifier shown in shortcut hints.
 */
export const kfmt = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
      : `${Math.round(n)}`;

/** context window as "200k"; unknown → "—" */
export const ctxFmt = (n: number | null): string =>
  n == null ? '—' : `${(n / 1000).toLocaleString()}k`;

/** cost: 6 decimals below $0.0001, 4 below $0.01, 2 above */
export const $fmt = (v: number): string =>
  v === 0
    ? '$0.00'
    : v < 0.0001
      ? `$${v.toFixed(6)}`
      : v < 0.01
        ? `$${v.toFixed(4)}`
        : `$${v.toFixed(2)}`;

export const bytesFmt = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}MB`
    : n >= 1000
      ? `${Math.round(n / 1000)}KB`
      : `${n}B`;

/** model size as "16.8 GB"; local runtimes report bytes */
export const humanBytes = (n: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const num = v >= 100 ? Math.round(v) : Number(v.toFixed(1));
  return `${num} ${units[i]}`;
};

/** local wall-clock time as "14:05" */
export const timeOfDay = (ts: number): string =>
  new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });

/** full local timestamp to the second, e.g. "12 Mar 2026, 14:05:03" */
export const fullTimestamp = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

export const timeAgo = (ts: number, now = Date.now()): string => {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / (86400 * 30))}mo ago`;
};

export type RecencyGroup =
  | 'TODAY'
  | 'YESTERDAY'
  | 'PREVIOUS 7 DAYS'
  | 'PREVIOUS 30 DAYS'
  | 'OLDER';

export const recencyGroup = (ts: number, now = Date.now()): RecencyGroup => {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayMs = 86400000;
  if (ts >= startOfToday.getTime()) return 'TODAY';
  if (ts >= startOfToday.getTime() - dayMs) return 'YESTERDAY';
  if (ts >= now - dayMs * 7) return 'PREVIOUS 7 DAYS';
  if (ts >= now - dayMs * 30) return 'PREVIOUS 30 DAYS';
  return 'OLDER';
};

export const GROSS_TOKENS = (text: string): number =>
  Math.ceil(text.length / 4);

export const modKey = (): string =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    ? '⌘'
    : 'Ctrl';

export const greeting = (d = new Date()): string => {
  const h = d.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
};

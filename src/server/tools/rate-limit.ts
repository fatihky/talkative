/*
 * tools/rate-limit — handles upstream "you're rate limited" responses for
 * the throttled tools (web_search and http_fetch).
 *
 * Business logic:
 * - callWithRetry wraps an upstream fetch for these tools and, when the
 *   upstream answers 429 (rate limited), retries a bounded number of times
 *   with exponential backoff instead of failing the call outright.
 * - the backoff honours the upstream's own hint first: a numeric
 *   `Retry-After` header (seconds) or an RFC 7231 HTTP date wins, then a
 *   rough `X-RateLimit-Reset` delta, then the per-tool default. Every delay
 *   is capped at MAX_WAIT_MS and raced against the run's abort signal, so a
 *   stop mid-wait ends the call rather than hanging.
 * - `X-RateLimit-Remaining: 0` (or a `429`) also records a cooldown for the
 *   caller's scope (see below), so *concurrent* sibling calls on the same
 *   key back off too instead of each firing one doomed attempt first.
 * - the retry is conservative: 429 only. A 5xx is transient too, but these
 *   providers surface auth debt as 401/402/403 and quota debt as 429, so
 *   retrying 5xx here would mask real outages behind extra fan-out.
 * - when every retry is exhausted the original response/status is rethrown
 *   as the same "… → <status>: <body>" error the tools already produce, so
 *   the model still sees a clean failure.
 */
import type { ServerTool } from './index';

export type RateScope = string;

type RetryOptions = {
  /* upper bound on a single backoff wait */
  maxWaitMs?: number;
};

/* some providers report a one-minute window; a large Retry-After is culled either way */
const DEFAULT_WAIT_MS = 1_000;
const MAX_WAIT_MS = 30_000;
const MAX_ATTEMPTS = 3;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/* "retry after" from the response: numeric Retry-After (seconds), HTTP-date,
   or an X-RateLimit-Reset delta; null when the upstream didn't say. */
const retryAfterMs = (res: Response): number | null => {
  const ra = res.headers.get('retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs) && secs >= 0) return secs * 1_000;
    const date = Date.parse(ra);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  const reset = res.headers.get('x-ratelimit-reset');
  if (reset && Number.isFinite(Number(reset))) {
    const until = Number(reset) * 1_000;
    const now = Date.now();
    /* the header may be a unix timestamp or an already-relative delta */
    const delta = until > now ? until - now : until;
    if (delta > 0) return delta;
  }
  return null;
};

const remaining = (res: Response): number | null => {
  const r = res.headers.get('x-ratelimit-remaining');
  return r === null ? null : Number(r);
};

/* whether this response means "slow down now" (429, or a drained quota) */
export const isRateLimited = (res: Response): boolean =>
  res.status === 429 || remaining(res) === 0;

const REMEMBER_MS = 30_000;
const MIN_BACKOFF_MS = 500;

/* ── per-scope cooldown (cached on globalThis, single-instance like the runs map) ── */
type Cooldown = { until: number; minWaitMs: number };
const g = globalThis as typeof globalThis & {
  __toolRateCooldowns?: Map<string, Cooldown>;
};
g.__toolRateCooldowns ??= new Map<string, Cooldown>();
const cooldowns = g.__toolRateCooldowns;

const recordCooldown = (scope: string, waitMs: number) => {
  const existing = cooldowns.get(scope);
  const minWaitMs = Math.max(existing?.minWaitMs ?? 0, waitMs);
  cooldowns.set(scope, {
    until: Date.now() + minWaitMs,
    minWaitMs,
  });
};

const clearCooldown = (scope: string) => {
  const c = cooldowns.get(scope);
  if (c && Date.now() >= c.until) {
    cooldowns.delete(scope);
  }
};

/** wait out any cooldown a sibling call left for `scope`, before the first attempt */
const awaitCooldown = async (scope: string, signal: AbortSignal) => {
  for (;;) {
    const c = cooldowns.get(scope);
    if (!c) return;
    const wait = c.until - Date.now();
    if (wait <= 0) {
      cooldowns.delete(scope);
      return;
    }
    await sleep(wait, signal);
  }
};

/* ── the retrying fetch ───────────────────────────────────────────── */

/**
 * run `fn` (an upstream fetch) up to `attempts` times, backing off and
 * consulting `retryAfter` whenever the upstream reports it is rate limited.
 * returns the first non-rate-limited response, or the last response.
 */
export const callWithRetry = async (
  scope: RateScope,
  signal: AbortSignal,
  fn: (signal: AbortSignal) => Promise<Response>,
  opts?: RetryOptions,
): Promise<Response> => {
  const maxWait = Math.min(MAX_WAIT_MS, opts?.maxWaitMs ?? MAX_WAIT_MS);
  await awaitCooldown(scope, signal);
  let res = await fn(signal);
  let attempt = 1;
  while (
    isRateLimited(res) &&
    attempt < MAX_ATTEMPTS &&
    !signal.aborted
  ) {
    const backoff = retryAfterMs(res) ?? DEFAULT_WAIT_MS;
    const jitter = Math.floor(Math.random() * MIN_BACKOFF_MS);
    const wait = Math.min(maxWait, backoff + jitter);
    /* tell sibling calls on this key to wait too, even after we exhaust */
    recordCooldown(scope, Math.min(backoff, REMEMBER_MS));
    try {
      await sleep(wait, signal);
    } catch {
      return res;
    }
    res = await fn(signal);
    attempt++;
  }
  clearCooldown(scope);
  return res;
};

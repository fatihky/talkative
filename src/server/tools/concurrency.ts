/*
 * tools/concurrency — a semaphore capping how many tool calls run at once
 * per scope.
 *
 * Business logic:
 * - web_search and http_fetch share upstream rate limits, so invokeTool
 *   routes them through withConcurrency — but only when the user has a
 *   per-tool concurrency preference set; an unset preference means the call
 *   runs unthrottled.
 * - the scope key includes the tool name: "user:<id>:<tool>" for a user's
 *   own key (one pool per user per tool) or "shared:<provider>:<tool>" for
 *   an environment-defined system key (one pool across every user of that
 *   key), so the two tools are throttled independently.
 * - the limit comes from the preference on every acquire (the ui seeds and
 *   saves a default of 5), floored at 1, and an existing pool's cap is
 *   updated in place so a settings change applies from the next call on.
 * - waiters queue FIFO and a release hands the slot to the next one; an
 *   abort while waiting removes the waiter and rejects with the signal's
 *   reason, so a stopped run never leaks a queued slot.
 * - the pools are cached on globalThis like the runs map, since this is
 *   single-instance.
 */

class Semaphore {
  limit: number;
  private active = 0;
  private waiters: { grant: () => void; onAbort: () => void }[] = [];

  constructor(limit: number) {
    this.limit = limit;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise<() => void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const entry = {
        settled: false,
        grant: () => {
          if (entry.settled) return;
          entry.settled = true;
          signal.removeEventListener('abort', entry.onAbort);
          this.active++;
          resolve(() => {
            this.active--;
            const next = this.waiters.shift();
            if (next) next.grant();
          });
        },
        onAbort: () => {
          if (entry.settled) return;
          entry.settled = true;
          const i = this.waiters.indexOf(entry);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(signal.reason);
        },
      };
      signal.addEventListener('abort', entry.onAbort, { once: true });
      if (this.active < this.limit) entry.grant();
      else this.waiters.push(entry);
    });
  }
}

const g = globalThis as typeof globalThis & {
  __toolSemaphores?: Map<string, Semaphore>;
};
g.__toolSemaphores ??= new Map<string, Semaphore>();
const semaphores = g.__toolSemaphores;

/** runs `fn` once a slot for `scope` is free; `limit` sets the pool's capacity */
export const withConcurrency = <T>(
  scope: string,
  limit: number,
  signal: AbortSignal,
  fn: () => Promise<T>,
): Promise<T> => {
  const max = Math.max(1, Math.trunc(Number(limit)) || 1);
  let sem = semaphores.get(scope);
  if (!sem) {
    sem = new Semaphore(max);
    semaphores.set(scope, sem);
  } else {
    sem.limit = max;
  }
  return sem.acquire(signal).then((release) =>
    fn().finally(() => {
      release();
    }),
  );
};

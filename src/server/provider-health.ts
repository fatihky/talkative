/*
 * ProviderHealth — per-connection status behind GET
 * /api/provider-health, loaded at boot into the network store and
 * driving the rate-limit banner.
 *
 * Business logic:
 * - health rides on the model catalog: each connection is probed via
 *   getCatalog, so a fresh redis cache answers `ok` without touching
 *   upstream, while a stale entry reports the last fetch's error.
 * - all connections are checked in parallel; per connection, an
 *   error matching 429 / "rate limit" becomes `rate_limited`, any
 *   other error stays `error`, success is `ok`.
 * - resetInSec is a flat 60 s hint for the ui countdown — upstreams
 *   don't report a reset time, so the banner estimates rather than
 *   relays.
 * - getCatalog already catches upstream failures into entry.error,
 *   so the try/catch here only covers unexpected throws; either way
 *   every connection gets a status and the request never fails.
 * - latencyMs is the wall time of the whole parallel sweep.
 */
import type { Provider } from '../types';
import { getCatalog } from './catalog';
import { listConnections } from './providers';

/**
 * health of each configured provider connection, derived from the model catalog fetch.
 * a connection whose upstream is unreachable reports `error`; a 429 reports `rate_limited`.
 */
export const providerHealth = async (
  userId: string,
): Promise<{ providers: Provider[]; latencyMs: number }> => {
  const started = Date.now();
  const conns = await listConnections(userId);
  const providers = await Promise.all(
    conns.map(async (conn): Promise<Provider> => {
      const id = String(conn.id);
      try {
        const entry = await getCatalog(conn);
        if (entry.error) {
          const rateLimited = /\b429\b|rate ?limit/i.test(entry.error);
          return {
            id,
            label: conn.name,
            status: rateLimited ? 'rate_limited' : 'error',
            ...(rateLimited ? { resetInSec: 60 } : {}),
          };
        }
        return { id, label: conn.name, status: 'ok' };
      } catch {
        return { id, label: conn.name, status: 'error' };
      }
    }),
  );
  return { providers, latencyMs: Date.now() - started };
};

/*
 * redis — the one shared cache client for the process.
 *
 * Business logic:
 * - getRedis memoizes a single ioredis client on globalThis, created on
 *   first use, so dev-server HMR reloads reuse one connection instead of
 *   opening a new one per reload — the app's single-instance assumption.
 * - Redis is strictly a cache (the model catalog lives here), never the
 *   source of truth, so the client is tuned to fail fast when it's down:
 *   maxRetriesPerRequest=1 and commandTimeout=1000ms bound how long a
 *   command can block, letting callers fall back to the upstream provider
 *   rather than hang.
 * - It attaches an 'error' listener so ioredis doesn't surface every
 *   failed reconnect as unhandled; a `down` flag collapses an outage into
 *   a single warning, and 'ready' clears it for the next one.
 * - REDIS_URL falls back to redis://localhost:6379; dotenv/config is
 *   loaded here so the var is present even outside the app's own env setup.
 */
import 'dotenv/config';
import { Redis } from 'ioredis';

/* cached on globalThis so dev-server HMR doesn't open a new connection per reload */
const g = globalThis as typeof globalThis & { __redis?: Redis };

const create = () => {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    /* redis is only a cache: bound how long a command can wait while it's down, callers fall back to upstream */
    maxRetriesPerRequest: 1,
    commandTimeout: 1000,
  });
  /* without a listener ioredis logs every failed reconnect as unhandled; log once per outage instead */
  let down = false;
  redis.on('error', (e: NodeJS.ErrnoException) => {
    if (down) return;
    down = true;
    /* ECONNREFUSED arrives as an AggregateError with an empty message */
    console.warn(`[redis] unavailable: ${e.message || e.code || e.name}`);
  });
  redis.on('ready', () => {
    down = false;
  });
  return redis;
};

export const getRedis = (): Redis => (g.__redis ??= create());

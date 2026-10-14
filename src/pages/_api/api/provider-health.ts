/*
 * provider-health — GET /api/provider-health — liveness of each
 * provider connection the caller has configured.
 *
 * Business logic:
 * - Session-only via `handle` (401 with no session) and scoped to the
 *   caller's own connections; there is no admin variant and no way to
 *   probe somebody else's providers.
 * - Thin wrapper over server/provider-health, which reuses the model
 *   catalog fetch as the probe: "healthy" means that connection's list
 *   call worked — served from redis while the cache is fresh, from
 *   upstream when it isn't.
 * - Disabled connections are probed too: health describes what is
 *   configured, not what the composer currently draws from.
 * - Errors are per connection, never per request. A catalog entry
 *   carrying an error becomes 'error', or 'rate_limited' with a 60s
 *   reset hint when the text mentions 429/rate limit, and a throw is
 *   caught so one dead provider can't 500 the response. latencyMs is
 *   the wall time of the parallel probes.
 * - Nothing is written or invalidated here, but a probe that reaches
 *   upstream still refreshes that connection's cached catalog.
 */
import { handle } from '../../../server/providers';
import { providerHealth } from '../../../server/provider-health';

/* GET /api/provider-health — status of each configured provider connection */
export const GET = () =>
  handle(async (userId) => Response.json(await providerHealth(userId)));

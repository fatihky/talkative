/*
 * Models — GET /api/models[?refresh=1] — merged model catalog across
 * the user's enabled provider connections.
 *
 * Business logic:
 * - auth via handle(); connections are per-user rows (listConnections
 *   scopes by userId), so there is no shared model list and no admin
 *   bypass.
 * - only enabled connections are queried; getCatalog() runs per
 *   connection in parallel, serving from the redis cache while fresh,
 *   refetching upstream when ?refresh is present, and falling back to
 *   a stale cache when the provider is down (server/catalog.ts).
 * - one provider failing never fails the route: its message lands in
 *   errors[connectionId] beside the items from everyone else, so the
 *   picker still renders and the UI can show per-provider warnings.
 * - syncedAt is the *oldest* entry's timestamp — the merged list is
 *   only as fresh as its stalest source, and reporting now() would
 *   overstate freshness.
 * - providerCount counts disabled connections too: turning every
 *   provider off must empty the picker instead of letting the UI fall
 *   back to the demo catalog.
 */
import { getCatalog } from '../../../server/catalog';
import { handle, listConnections } from '../../../server/providers';
import type { Model } from '../../../types';

/* GET /api/models[?refresh=1] — merged model list across every enabled provider */
export const GET = (req: Request) =>
  handle(async (userId) => {
    const refresh = new URL(req.url).searchParams.has('refresh');
    const all = await listConnections(userId);
    const conns = all.filter((c) => c.enabled);
    const entries = await Promise.all(
      conns.map((c) => getCatalog(c, { refresh })),
    );
    const items: Model[] = entries.flatMap((e) => e.items);
    const errors = Object.fromEntries(
      conns.flatMap((c, i) => {
        const err = entries[i]?.error;
        return err ? [[c.id, err]] : [];
      }),
    );
    return Response.json({
      items,
      /* oldest list wins so the UI never overstates freshness */
      syncedAt: Math.min(Date.now(), ...entries.map((e) => e.syncedAt)),
      /* counts disabled ones too, so turning every provider off empties the picker
         instead of bringing back the demo catalog */
      providerCount: all.length,
      errors,
    });
  });
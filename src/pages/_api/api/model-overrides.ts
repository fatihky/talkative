/*
 * model-overrides — GET /api/model-overrides — the caller's model
 * corrections and custom models, as they apply to the current catalog.
 *
 * Business logic:
 * - Session-only via `handle`; rows are per user, so there is nothing
 *   shared or admin-only here.
 * - Merges the rows over every enabled connection's catalog through
 *   model-overrides.applyOverrides — the exact merge GET /api/models
 *   runs — so the settings screen edits the same rows the composer
 *   sees, including custom models and (via `hidden`) the ones the merge
 *   dropped.
 * - Items carry their applied `overrides`, so the editor can prefill
 *   from the same payload it renders.
 * - syncedAt is the oldest entry's timestamp, like GET /api/models;
 *   `connections` names the connections a custom model can target.
 * - ?refresh=1 refetches every provider, like GET /api/models: settings
 *   passes it on its first load so a model added upstream since the
 *   cache was written can be overridden straight away.
 * - ?provider=<name> narrows the list to the connections sharing that
 *   name (what the catalog calls `provider`). Matching happens here, not
 *   in the client, because a provider whose every model is hidden has no
 *   items left to name it — its ids still parse to a connection. Hidden
 *   ids are narrowed the same way, so the filter is coherent. connections
 *   stays the full list: it names who a custom model may be sent to.
 */
import { getCatalog } from '../../../server/catalog';
import {
  applyOverrides,
  listOverrides,
  toDto as overrideDto,
} from '../../../server/model-overrides';
import { listConnections, handle } from '../../../server/providers';
import { parseModelId } from '../../../server/model-id';
import type { Model } from '../../../types';

/* GET /api/model-overrides[?refresh=1][&provider=<name>] — the catalog with the caller's overrides applied */
export const GET = (req: Request) =>
  handle(async (userId) => {
    const params = new URL(req.url).searchParams;
    const refresh = params.has('refresh');
    const provider = params.get('provider')?.trim() ?? '';
    const overrides = await listOverrides(userId);
    const all = await listConnections(userId);
    const conns = all
      .filter((c) => c.enabled)
      .filter((c) => !provider || c.name === provider);
    /* every connection by id, so hidden ids filter even when their provider is off */
    const names = new Map(all.map((c) => [c.id, c.name]));
    const inFilter = (id: string) =>
      !provider || names.get(parseModelId(id)?.connectionId ?? -1) === provider;
    const entries = await Promise.all(
      conns.map((c) => getCatalog(c, { refresh })),
    );
    const items: Model[] = entries.flatMap((e) => e.items);
    const { items: merged, flags } = applyOverrides(
      items,
      overrides,
      (cid) => conns.find((c) => c.id === cid)?.name,
    );
    return Response.json({
      items: merged.map((m) => {
        const o = overrides.get(m.id);
        return o ? { ...m, overrides: overrideDto(o) } : m;
      }),
      hidden: [...flags].flatMap(([id, f]) => (f.hidden && inFilter(id) ? [id] : [])),
      syncedAt: Math.min(Date.now(), ...entries.map((e) => e.syncedAt)),
      connections: conns.map((c) => ({ id: c.id, name: c.name })),
    });
  });

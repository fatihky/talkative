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
 * - `hidden` names each hidden model's provider (the connection name), so
 *   the settings provider filter can narrow them on the client without a
 *   refetch: an id alone can't say, since a custom id needn't carry its
 *   connection. Hidden custom models are listed too, else they could
 *   never be unhidden.
 */
import { getCatalog } from '../../../server/catalog';
import {
  applyOverrides,
  listOverrides,
  toDto as overrideDto,
} from '../../../server/model-overrides';
import { parseModelId } from '../../../server/model-id';
import { handle, listConnections } from '../../../server/providers';
import type { Model } from '../../../types';

/* GET /api/model-overrides[?refresh=1] — the catalog with the caller's overrides applied */
export const GET = (req: Request) =>
  handle(async (userId) => {
    const refresh = new URL(req.url).searchParams.has('refresh');
    const overrides = await listOverrides(userId);
    const conns = (await listConnections(userId)).filter((c) => c.enabled);
    const entries = await Promise.all(
      conns.map((c) => getCatalog(c, { refresh })),
    );
    const providerOf = (cid: number) => conns.find((c) => c.id === cid)?.name;
    const items: Model[] = entries.flatMap((e) => e.items);
    const { items: merged, flags } = applyOverrides(
      items,
      overrides,
      providerOf,
    );
    const hidden = [...overrides].flatMap(([id, o]) => {
      if (!o.hidden) return [];
      /* a catalog model the merge dropped, or a custom one on a live connection */
      const custom = o.connectionId !== undefined;
      if (!flags.has(id) && !custom) return [];
      const provider = providerOf(o.connectionId ?? parseModelId(id)?.connectionId ?? -1);
      if (custom && !provider) return [];
      return [{ id, provider }];
    });
    return Response.json({
      items: merged.map((m) => {
        const o = overrides.get(m.id);
        return o ? { ...m, overrides: overrideDto(o) } : m;
      }),
      hidden,
      syncedAt: Math.min(Date.now(), ...entries.map((e) => e.syncedAt)),
      connections: conns.map((c) => ({ id: c.id, name: c.name })),
    });
  });

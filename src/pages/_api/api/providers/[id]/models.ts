/*
 * providers/[id]/models — GET /api/providers/:id/models — one
 * connection's model catalog, for /settings/providers.
 *
 * Business logic:
 * - Session-only via `handle`; parseId plus findConnection scope it to
 *   the caller's own connection and 404 otherwise, so a catalog can't
 *   be read by guessing somebody else's provider id.
 * - Thin wrapper over server/catalog's getCatalog: redis while the
 *   entry is fresh (10 min), upstream after that, with `?refresh=1`
 *   forcing the refetch behind the UI's Refresh button.
 * - The route hands getCatalog the stored row as-is; the key is opened
 *   with decryptSecret() once, inside the fetch, and the reply carries
 *   only models, syncedAt and an optional error — never the key.
 * - An unreachable upstream is not a failure here: 200 with `error` set
 *   and the cached models marked 'stale', so a dead provider still
 *   shows what it last reported instead of an empty list.
 * - Read-only apart from getCatalog's own cache write; no invalidation.
 */
import type { ApiContext } from 'waku/router';
import { getCatalog } from '../../../../../server/catalog';
import {
  findConnection,
  handle,
  notFound,
  parseId,
} from '../../../../../server/providers';

/* GET /api/providers/:id/models[?refresh=1] — one provider's model list */
export const GET = (
  req: Request,
  { params }: ApiContext<'/api/providers/[id]/models'>,
) =>
  handle(async (userId) => {
    const id = parseId(params.id);
    if (id === null) return notFound();
    const conn = await findConnection(userId, id);
    if (!conn) return notFound();
    const refresh = new URL(req.url).searchParams.has('refresh');
    return Response.json(await getCatalog(conn, { refresh }));
  });

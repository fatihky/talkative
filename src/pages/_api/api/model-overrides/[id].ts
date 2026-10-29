/*
 * model-overrides/[id] — GET / PUT / DELETE /api/model-overrides/:id —
 * the caller's override for one model, or a custom model they added.
 *
 * Business logic:
 * - :id is the id the composer sends, url-encoded: a catalog id
 *   (`3:openai/gpt-5`) or a custom model's own id. Waku decodes route
 *   params, so an id containing `/` arrives whole; the client encodes it.
 * - Session-only via `handle`; rows are keyed (userId, modelId), so one
 *   user can never read, edit or drop another's override.
 * - GET answers the merged model with its `overrides` attached — 404
 *   when that id isn't in the caller's list (unknown, or hidden).
 * - PUT validates through model-overrides.parseInput: a `custom: true`
 *   body requires connectionId + remoteId, and the connection must be
 *   the caller's own (findConnection scopes by user; 404 otherwise). A
 *   PUT whose fields are all empty drops the row, so "clear" and
 *   "reset" mean the same thing.
 * - DELETE is idempotent: 204 whether or not a row existed.
 * - Everything is applied on read, so no catalog cache needs dropping.
 */
import type { ApiContext } from 'waku/router';
import { getCatalog } from '../../../../server/catalog';
import {
  applyOverrides,
  listOverrides,
  parseInput,
  removeOverride,
  saveOverride,
  toDto as overrideDto,
} from '../../../../server/model-overrides';
import {
  findConnection,
  handle,
  listConnections,
  notFound,
} from '../../../../server/providers';
import type { Model } from '../../../../types';

type Ctx = ApiContext<'/api/model-overrides/[id]'>;

/* GET /api/model-overrides/:id — this model with the caller's overrides applied */
export const GET = (_req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    const overrides = await listOverrides(userId);
    const o = overrides.get(params.id);
    /* a hidden model is not served here: it has left every list */
    if (o?.hidden) return notFound();
    const conns = (await listConnections(userId)).filter((c) => c.enabled);
    const entries = await Promise.all(conns.map((c) => getCatalog(c)));
    const items: Model[] = entries.flatMap((e) => e.items);
    const { items: merged } = applyOverrides(items, overrides, (cid) =>
      conns.find((c) => c.id === cid)?.name,
    );
    const model = merged.find((m) => m.id === params.id);
    if (!model) return notFound();
    return Response.json(
      o ? { ...model, overrides: overrideDto(o) } : model,
    );
  });

/* PUT /api/model-overrides/:id — set this model's overrides (an all-empty body resets it) */
export const PUT = (req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    const input = parseInput(params.id, await req.json());
    const cid = input.base.connectionId;
    if (cid !== null && !(await findConnection(userId, cid))) return notFound();
    await saveOverride(userId, params.id, input);
    return Response.json(overrideDto(input.override));
  });

/* DELETE /api/model-overrides/:id — back to what the provider reports */
export const DELETE = (_req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    await removeOverride(userId, params.id);
    return new Response(null, { status: 204 });
  });

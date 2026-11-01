/*
 * model-overrides/[id] — GET / PUT / DELETE /api/model-overrides/:id —
 * the caller's override for one model, or a model they added.
 *
 * Business logic:
 * - :id is the id the composer sends, url-encoded: the catalog id
 *   (`3:openai/gpt-5`). The client encodes it because an unencoded `/`
 *   would split the path segment, and Waku hands api params through as
 *   they appear in the url, so the handler decodes exactly once and
 *   splits it into the (connectionId, modelId) pair a row is keyed by.
 *   Chats may still carry an older `custom:`-prefixed id; parseModelId
 *   maps it onto the same pair.
 * - Session-only via `handle`; rows are keyed (userId, connectionId,
 *   modelId), so one user can never read, edit or drop another's
 *   override.
 * - GET answers the merged model with its `overrides` attached — 404
 *   when that id isn't in the caller's list (unknown, or hidden).
 * - PUT validates through model-overrides.parseInput and requires the
 *   connection to be the caller's own (findConnection scopes by user;
 *   404 otherwise). A PUT for a listed model whose fields are all empty
 *   drops the row, so "clear" and "reset" mean the same thing; a
 *   user-added model's row is the model itself and is never dropped.
 * - DELETE is idempotent: 204 whether or not a row existed.
 * - Everything is applied on read, so no catalog cache needs dropping.
 */
import type { ApiContext } from 'waku/router';
import { getCatalog } from '../../../../server/catalog';
import {
  applyOverrides,
  isEmptyOverride,
  isRedundantCapabilities,
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
import { parseModelId } from '../../../../server/model-id';
import type { Model } from '../../../../types';

type Ctx = ApiContext<'/api/model-overrides/[id]'>;

/* Waku matches api routes on the raw pathname and passes params through
   percent-encoded, so decode exactly once and split into the pair a row
   is keyed by; a malformed or unparseable id addresses no row */
const target = (
  raw: string,
): { connectionId: number; modelId: string } | undefined => {
  let id = raw;
  if (id.includes('%')) {
    try {
      id = decodeURIComponent(id);
    } catch {
      return undefined;
    }
  }
  const parsed = parseModelId(id);
  return parsed
    ? { connectionId: parsed.connectionId, modelId: parsed.remoteId }
    : undefined;
};

/* GET /api/model-overrides/:id — this model with the caller's overrides applied */
export const GET = (_req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    const t = target(params.id);
    if (!t) return notFound();
    const key = `${t.connectionId}:${t.modelId}`;
    const overrides = await listOverrides(userId);
    const o = overrides.get(key);
    /* a hidden model is not served here: it has left every list */
    if (o?.hidden) return notFound();
    const conns = (await listConnections(userId)).filter((c) => c.enabled);
    const entries = await Promise.all(conns.map((c) => getCatalog(c)));
    const items: Model[] = entries.flatMap((e) => e.items);
    const listed = items.some((m) => m.id === key);
    const { items: merged } = applyOverrides(items, overrides, (cid) =>
      conns.find((c) => c.id === cid)?.name,
    );
    const model = merged.find((m) => m.id === key);
    if (!model) return notFound();
    return Response.json(
      o ? { ...model, overrides: overrideDto(o, !listed) } : model,
    );
  });

/* PUT /api/model-overrides/:id — set this model's overrides (an all-empty body resets it) */
export const PUT = (req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    const t = target(params.id);
    if (!t) return notFound();
    const input = parseInput(t, await req.json());
    if (!(await findConnection(userId, t.connectionId))) return notFound();
    /* capabilities are merged over the provider's flags, so a block that only
       restates them would pin today's catalog onto the row and hide what the
       provider starts reporting later; it's dropped unless it says something */
    const conns = await listConnections(userId);
    const catalog = (
      await Promise.all(conns.map((c) => getCatalog(c)))
    ).flatMap((e) => e.items)
      .find((m) => m.id === `${t.connectionId}:${t.modelId}`);
    if (isRedundantCapabilities(input.override.capabilities, catalog?.capabilities)) {
      const { capabilities: _caps, ...rest } = input.override;
      input.override = rest;
    }
    if (catalog && isEmptyOverride(input.override)) {
      /* nothing left to override: forget the row instead of storing blanks */
      await removeOverride(userId, t.connectionId, t.modelId);
      return Response.json(overrideDto(input.override, false));
    }
    await saveOverride(userId, t.connectionId, t.modelId, input);
    return Response.json(overrideDto(input.override, !catalog));
  });

/* DELETE /api/model-overrides/:id — back to what the provider reports */
export const DELETE = (_req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    const t = target(params.id);
    if (!t) return notFound();
    await removeOverride(userId, t.connectionId, t.modelId);
    return new Response(null, { status: 204 });
  });

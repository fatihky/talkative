/*
 * providers/[id] — GET/PUT/PATCH/DELETE /api/providers/:id — one of
 * the caller's provider connections.
 *
 * Business logic:
 * - Session-only via `handle`, with ownership checked twice: parseId
 *   rejects any id that isn't a positive int4 and findConnection
 *   matches on (id, userId) — both answer 404 'provider not found', so
 *   another user's connection is indistinguishable from a missing one
 *   instead of leaking its existence through a 403.
 * - GET returns the connection as toDto: name, baseUrl, compatibility,
 *   enabled, timestamps and hasApiKey. The key value never comes back,
 *   which is why the edit form can't prefill it.
 * - PUT rewrites name/baseUrl/compatibility wholesale and touches
 *   apiKey only when the field is present: omitted keeps the stored key
 *   (the client sends a blank field), an explicit null clears it, a
 *   string is sealed with encryptSecret() first. A key can't
 *   round-trip, so this is a full-config save, not a partial patch.
 * - PATCH exists for the enable switch and accepts only `enabled`
 *   (parseToggle), so toggling a provider never has to resend — or risk
 *   wiping — its config and stored key.
 * - DELETE removes the row and answers 204 with no body.
 * - Side effect: PUT and DELETE call invalidateCatalog(id) to drop the
 *   redis model list, since a changed url/key/compatibility makes the
 *   cached catalog untrustworthy. PATCH doesn't: toggling `enabled`
 *   leaves the catalog valid and only hides it from the merged picker.
 * - Validation → 400; losing the race on the write throws, which
 *   `handle` turns into a 500 'internal error'.
 */
import { eq } from 'drizzle-orm';
import type { ApiContext } from 'waku/router';
import { getDb } from '../../../../db';
import { providerConnections } from '../../../../db/schema';
import { invalidateCatalog } from '../../../../server/catalog';
import {
  findConnection,
  handle,
  notFound,
  parseId,
  parseInput,
  parseToggle,
  toDto,
} from '../../../../server/providers';
import { encryptSecret } from '../../../../server/secrets';

type Ctx = ApiContext<'/api/providers/[id]'>;

export const GET = (_req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    const id = parseId(params.id);
    if (id === null) return notFound();
    const conn = await findConnection(userId, id);
    return conn ? Response.json(toDto(conn)) : notFound();
  });

export const PUT = (req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    const id = parseId(params.id);
    if (id === null) return notFound();
    const input = parseInput(await req.json());
    const db = getDb();
    const conn = await findConnection(userId, id);
    if (!conn) return notFound();
    const set: Record<string, unknown> = {
      name: input.name,
      baseUrl: input.baseUrl,
      compatibility: input.compatibility,
    };
    if (input.apiKey !== undefined) set.apiKey = encryptSecret(input.apiKey);
    const [updated] = await db
      .update(providerConnections)
      .set(set)
      .where(eq(providerConnections.id, id))
      .returning();
    if (!updated) throw new Error('update failed');
    /* url/key/compat may have changed — the cached list is no longer trustworthy */
    await invalidateCatalog(updated.id);
    return Response.json(toDto(updated));
  });

/* toggles a provider on/off without resending its config (the api key can't round-trip) */
export const PATCH = (req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    const id = parseId(params.id);
    if (id === null) return notFound();
    const { enabled } = parseToggle(await req.json());
    const db = getDb();
    const conn = await findConnection(userId, id);
    if (!conn) return notFound();
    const [updated] = await db
      .update(providerConnections)
      .set({ enabled })
      .where(eq(providerConnections.id, id))
      .returning();
    if (!updated) throw new Error('update failed');
    return Response.json(toDto(updated));
  });

export const DELETE = (_req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    const id = parseId(params.id);
    if (id === null) return notFound();
    const db = getDb();
    const conn = await findConnection(userId, id);
    if (!conn) return notFound();
    await db.delete(providerConnections).where(eq(providerConnections.id, id));
    await invalidateCatalog(id);
    return new Response(null, { status: 204 });
  });

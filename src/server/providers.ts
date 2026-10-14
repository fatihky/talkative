/*
 * Providers — connection CRUD helpers plus the shared request wrapper
 * every api route in the app is built on.
 *
 * Business logic:
 * - handle() is the auth + error boundary for all /api routes: no
 *   session → 401; ValidationError → 400; a SyntaxError (malformed
 *   JSON body) → 400; anything else is logged and becomes a generic
 *   500 so internals never leak to the client.
 * - connections are user-scoped: listConnections/findConnection
 *   always filter by the signed-in user's id, so one user can never
 *   read or mutate another's providers.
 * - toDto is the only shape clients see and carries just `hasApiKey`
 *   — the stored key (sealed or plaintext) never round-trips. that's
 *   also why PATCH only toggles `enabled` (parseToggle): a key
 *   change needs a full PUT because it can't be read back.
 * - parseInput requires name, compatibility and an http(s) base url,
 *   normalizes the url via catalog.normalizeBaseUrl (typed /v1 etc.
 *   suffixes are stripped), and treats an empty apiKey string as
 *   null (remove the key); omitting apiKey leaves the stored one
 *   untouched on update.
 * - parseId accepts only positive int4-shaped route params —
 *   anything else can't match a serial row and short-circuits to
 *   notFound() instead of hitting the db.
 */
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../db';
import { type ProviderConnectionRow, providerConnections } from '../db/schema';
import type {
  Compatibility,
  ProviderConnection as ProviderConnectionDto,
  ProviderConnectionInput,
} from '../types';
import { getSession } from './auth';
import { normalizeBaseUrl } from './catalog';
import { ValidationError } from './errors';

const COMPATIBILITIES = [
  'openai',
  'openrouter',
  'lmstudio',
  'ollama',
  'bifrost',
] as const satisfies readonly Compatibility[];

export const toDto = (c: ProviderConnectionRow): ProviderConnectionDto => ({
  id: c.id,
  name: c.name,
  baseUrl: c.baseUrl,
  compatibility: c.compatibility,
  hasApiKey: !!c.apiKey,
  enabled: c.enabled,
  createdAt: c.createdAt.getTime(),
  updatedAt: c.updatedAt.getTime(),
});

export { ValidationError } from './errors';

const isCompat = (v: unknown): v is Compatibility =>
  (COMPATIBILITIES as readonly unknown[]).includes(v);

/** validates a create/update body; name, base url and compatibility are all required */
export const parseInput = (body: unknown): ProviderConnectionInput => {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) throw new ValidationError('name is required');
  if (!isCompat(b.compatibility))
    throw new ValidationError(
      `compatibility is required (one of: ${COMPATIBILITIES.join(', ')})`,
    );
  const rawUrl = typeof b.baseUrl === 'string' ? b.baseUrl.trim() : '';
  if (!rawUrl) throw new ValidationError('base url is required');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError('base url is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new ValidationError('base url must be http(s)');
  if (
    b.apiKey !== undefined &&
    b.apiKey !== null &&
    typeof b.apiKey !== 'string'
  )
    throw new ValidationError('apiKey must be a string');
  const apiKey =
    typeof b.apiKey === 'string' ? b.apiKey.trim() || null : b.apiKey;
  return {
    name,
    baseUrl: normalizeBaseUrl(rawUrl, b.compatibility),
    compatibility: b.compatibility,
    ...(apiKey !== undefined ? { apiKey } : {}),
  };
};

/** validates a PATCH body; only the enabled flag can be toggled this way */
export const parseToggle = (body: unknown): { enabled: boolean } => {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.enabled !== 'boolean')
    throw new ValidationError('enabled must be a boolean');
  return { enabled: b.enabled };
};

export const listConnections = async (userId: string) =>
  getDb()
    .select()
    .from(providerConnections)
    .where(eq(providerConnections.userId, userId))
    .orderBy(asc(providerConnections.createdAt));

export const findConnection = async (userId: string, id: number) =>
  getDb()
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.id, id),
        eq(providerConnections.userId, userId),
      ),
    )
    .then((rows) => rows[0] ?? null);

/* maps thrown errors to json responses for the api routes; `fn` gets the signed-in user's id */
export const handle = async (fn: (userId: string) => Promise<Response>) => {
  try {
    /* require authentication for all API routes */
    const session = await getSession();
    if (!session) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    return await fn(session.user.id);
  } catch (e) {
    if (e instanceof ValidationError)
      return Response.json({ error: e.message }, { status: 400 });
    if (e instanceof SyntaxError)
      return Response.json({ error: 'invalid JSON body' }, { status: 400 });
    console.error(e);
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
};

/* route params arrive as strings; anything that isn't a positive int4 can't match a row */
export const parseId = (s: string): number | null => {
  if (!/^[1-9]\d{0,9}$/.test(s)) return null;
  const n = Number(s);
  return n <= 2_147_483_647 ? n : null;
};

export const notFound = () =>
  Response.json({ error: 'provider not found' }, { status: 404 });

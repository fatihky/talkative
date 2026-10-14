/*
 * tool-credentials — GET/PUT/DELETE /api/tool-credentials — the
 * caller's own API keys for tool providers (tavily, exa, github, …).
 *
 * Business logic:
 * - Session-only via `handle`, scoped to the session user on every
 *   method: rows are keyed (userId, provider) and all three queries
 *   filter on both, so nobody can read or overwrite another's key.
 * - Two kinds of key exist and only one is stored here. A user key
 *   lives in tool_credentials, sealed with encryptSecret(), and always
 *   wins when a tool runs. A system key comes from the environment, is
 *   never written through this API, and is usable only under the site's
 *   envKeyAccess policy (all / admins / none).
 * - GET returns the caller's credentials as DTOs (provider, hasApiKey,
 *   timestamps — never a value), the whole provider registry so the UI
 *   can draw a row per provider before any key is set, and isAdmin.
 * - providerKeyStates applies that access control: `env` (the variable
 *   name) is exposed to admins only, since they're the ones who set it,
 *   and `envShared` marks a system key this user may run on. An unset
 *   variable is left out entirely — no badge means "bring your own".
 * - PUT upserts one key: parseCredentialInput rejects an unknown
 *   provider and a non-string key (ValidationError → 400), a string is
 *   sealed before it's stored, null clears the stored key, and omitting
 *   apiKey means "keep what's there" — which 400s when nothing is
 *   stored. The reply is the DTO, so the key is never echoed back.
 * - DELETE takes ?provider=… (missing or blank → 400) and removes just
 *   that pair, answering 204 whether or not a row existed; the user
 *   then falls back to the system key if policy admits them to one.
 */
import { handle, ValidationError } from '../../../server/providers';
import { isAdmin } from '../../../server/settings';
import {
  deleteCredential,
  listCredentials,
  parseCredentialInput,
  providerKeyStates,
  saveCredential,
} from '../../../server/tool-credentials';

/* GET /api/tool-credentials — the user's own api keys (never the key values) plus the
   list of known providers, so the ui can render a row for each even before one is set */
export const GET = () =>
  handle(async (userId) => {
    const admin = await isAdmin(userId);
    const [items, providers] = await Promise.all([
      listCredentials(userId),
      providerKeyStates(admin),
    ]);
    return Response.json({ items, providers, isAdmin: admin });
  });

/* PUT /api/tool-credentials — upserts one key; apiKey null clears it */
export const PUT = (req: Request) =>
  handle(async (userId) => {
    const input = parseCredentialInput(await req.json());
    return Response.json(await saveCredential(userId, input));
  });

/* DELETE /api/tool-credentials?provider=… — removes the user's key for a provider */
export const DELETE = (req: Request) =>
  handle(async (userId) => {
    const url = new URL(req.url);
    const provider = url.searchParams.get('provider')?.trim() ?? '';
    if (!provider) throw new ValidationError('provider is required');
    await deleteCredential(userId, provider);
    return new Response(null, { status: 204 });
  });

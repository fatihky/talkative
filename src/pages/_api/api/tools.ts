/*
 * tools — GET /api/tools — which tools can actually run for this user,
 * and through which backends.
 *
 * Business logic:
 * - Session-only via `handle`, computed per request and never cached:
 *   the answer depends on the caller's own keys, on the site's
 *   envKeyAccess policy and on their isAdmin flag, all of which can
 *   change underneath.
 * - Thin wrapper over server/tools. loadToolAuth(userId, isAdmin)
 *   resolves the usable keys — the user's own tool_credentials, opened
 *   with decryptSecret(), always win, and an environment system key is
 *   admitted only when the policy allows this user — then toolStatuses
 *   maps that over the tool registry.
 * - Each item is { id, available, reason?, providers? }: reason is the
 *   human-readable 'not implemented yet' or 'no key configured for …'
 *   that the /tools screen and the composer's tool bar show instead of
 *   a greyed control with no explanation, and providers lists only the
 *   backends this user could pick.
 * - Grants aren't part of this route (see tool-preferences): a tool can
 *   be available here and still be switched off by the user.
 * - No key value, own or system, leaves the server through this route;
 *   read-only, no side effects.
 */
import { handle } from '../../../server/providers';
import { isAdmin } from '../../../server/settings';
import { loadToolAuth, toolStatuses } from '../../../server/tools';

/* GET /api/tools — which tools can run for the signed-in user, and their usable backends */
export const GET = () =>
  handle(async (userId) => {
    const auth = await loadToolAuth(userId, await isAdmin(userId));
    return Response.json({ items: toolStatuses(auth) });
  });

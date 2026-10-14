/*
 * users — GET/POST /api/users — admin-only account list and creation.
 *
 * Business logic:
 * - Session-only via `handle`, then isAdmin(userId) or 403
 *   {error:'forbidden'} on both methods; that 403 is what hides the
 *   whole user-management panel from a regular user instead of showing
 *   them an error.
 * - Accounts here are instance-wide, not the caller's own resource: GET
 *   lists every user oldest-first, and the admin gate is the only
 *   scoping there is — a non-admin can't reach the list at all.
 * - Delegation is total (parseUserCreate/createUser/listUsers live in
 *   server/users); every reply goes through toUserDto, which exposes
 *   id, name, email, isAdmin and epoch-ms timestamps but never a
 *   password hash.
 * - POST creates a credential account by hand the way better-auth's
 *   sign-up does: duplicate email and a password under 8 chars are
 *   400s, and the user row plus its 'credential' account row go in one
 *   transaction so no half-created login can exist. Replies 201.
 * - Users minted here are always non-admin and unverified — the only
 *   automatic promotion is the instance's first registrant — and admin
 *   rights come from `pnpm admin:grant`, not this API. There is no
 *   DELETE and no password reset.
 */
import { handle } from '../../../server/providers';
import { isAdmin } from '../../../server/settings';
import { createUser, listUsers, parseUserCreate } from '../../../server/users';

/* GET /api/users — every account, admins only */
export const GET = () =>
  handle(async (userId) => {
    if (!(await isAdmin(userId)))
      return Response.json({ error: 'forbidden' }, { status: 403 });
    return Response.json(await listUsers());
  });

/* POST /api/users — create an account with a password, admins only */
export const POST = (req: Request) =>
  handle(async (userId) => {
    if (!(await isAdmin(userId)))
      return Response.json({ error: 'forbidden' }, { status: 403 });
    const input = parseUserCreate(await req.json());
    return Response.json(await createUser(input), { status: 201 });
  });
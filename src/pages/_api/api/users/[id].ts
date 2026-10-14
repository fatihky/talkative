/*
 * users/[id] — PATCH /api/users/:id — admin-only edits to one account.
 *
 * Business logic:
 * - Session-only via `handle`, then isAdmin(userId) or 403
 *   {error:'forbidden'}. Unlike the per-user routes, the path id is
 *   deliberately not scoped to the caller: an admin may edit anybody,
 *   including themselves.
 * - Only name and email are patchable. parseUserPatch trims and
 *   normalizes them (email lowercased, format checked, 255-char limit),
 *   ignores other fields, and rejects an empty patch with 400 'nothing
 *   to update'.
 * - isAdmin and passwords are out of reach here: admin status changes
 *   go through `pnpm admin:grant` / `admin:revoke`, and the admin UI
 *   has no password reset and no account deletion at all.
 * - updateUser re-checks email uniqueness against every other user (a
 *   clash is a 400 with the server's message) and returns null when the
 *   id matches nobody, mapped here to 404 {error:'user not found'}.
 * - Replies with the updated user as toUserDto — never a password hash.
 */
import type { ApiContext } from 'waku/router';
import { handle } from '../../../../server/providers';
import { isAdmin } from '../../../../server/settings';
import { parseUserPatch, updateUser } from '../../../../server/users';

type Ctx = ApiContext<'/api/users/[id]'>;

/* PATCH /api/users/:id — update a user's email and/or name, admins only */
export const PATCH = (req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!(await isAdmin(userId)))
      return Response.json({ error: 'forbidden' }, { status: 403 });
    const patch = parseUserPatch(await req.json());
    const updated = await updateUser(params.id, patch);
    if (!updated)
      return Response.json({ error: 'user not found' }, { status: 404 });
    return Response.json(updated);
  });
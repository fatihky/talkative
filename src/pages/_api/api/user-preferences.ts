/*
 * user-preferences — GET/PATCH /api/user-preferences — the signed-in
 * user's own account-level preferences (currently the composer's Enter
 * key behaviour).
 *
 * Business logic:
 * - Session-only via `handle` and scoped to the session user; there is no
 *   user id in the path, so a request can only ever touch the caller's
 *   own row.
 * - GET returns the stored partial object ({} when nothing was saved), so
 *   the client can tell "never set" apart from "set to the default".
 * - PATCH validates with parseUserPrefs (an unknown key or a non-boolean
 *   enterToSend is a 400), merges it into the stored row and answers with
 *   the merged result rather than echoing the input.
 */
import { handle } from '../../../server/providers';
import {
  loadUserPrefs,
  parseUserPrefs,
  saveUserPrefs,
} from '../../../server/user-prefs';

/* GET /api/user-preferences — the caller's saved preferences */
export const GET = () =>
  handle(async (userId) => Response.json(await loadUserPrefs(userId)));

/* PATCH /api/user-preferences — merges the given keys, leaves the rest alone */
export const PATCH = (req: Request) =>
  handle(async (userId) => {
    const patch = parseUserPrefs(await req.json());
    return Response.json(await saveUserPrefs(userId, patch));
  });

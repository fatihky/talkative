/*
 * settings — GET/PATCH /api/settings — the instance's site-wide
 * policy, admins only.
 *
 * Business logic:
 * - Session-only via `handle`, then a second gate on both methods:
 *   isAdmin(userId) or 403 {error:'forbidden'}. That 403 is what makes
 *   the Site Settings panel render empty for a regular user who follows
 *   the URL, and the isAdmin flag in the GET response is what the shell
 *   uses to hide admin navigation.
 * - Settings are global, not per user: one app_settings row under the
 *   key 'site', read merged over defaults. This route is the only place
 *   they change, and there's no scoping past the admin check.
 * - GET adds isAdmin:true and hasUsers (the user table isn't empty),
 *   the latter telling the UI whether the "first user becomes admin"
 *   bootstrap is still in play.
 * - PATCH validates field by field with parseSettingsPatch — boolean
 *   registrationEnabled, envKeyAccess one of all/admins/none, unknown
 *   keys dropped, ValidationError → 400 — then patchSiteSettings does a
 *   read-modify-write of one merged object and returns the whole
 *   result, so the client can take the reply as the new state.
 * - envKeyAccess is policy, not a secret: it decides who may run tools
 *   on the environment-provided keys (see tool-credentials and tools).
 *   No key value is read or returned here.
 */

import { handle } from '../../../server/providers';
import {
  getSiteSettings,
  isAdmin,
  isFirstUser,
  parseSettingsPatch,
  patchSiteSettings,
} from '../../../server/settings';

/* GET /api/settings — full site settings, admins only */
export const GET = () =>
  handle(async (userId) => {
    if (!(await isAdmin(userId)))
      return Response.json({ error: 'forbidden' }, { status: 403 });
    const [settings, first] = await Promise.all([
      getSiteSettings(),
      isFirstUser(),
    ]);
    return Response.json({ ...settings, isAdmin: true, hasUsers: !first });
  });

/* PATCH /api/settings — update site settings, admins only */
export const PATCH = (req: Request) =>
  handle(async (userId) => {
    if (!(await isAdmin(userId)))
      return Response.json({ error: 'forbidden' }, { status: 403 });
    const patch = parseSettingsPatch(await req.json());
    return Response.json(await patchSiteSettings(patch));
  });

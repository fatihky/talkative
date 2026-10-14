/*
 * registration-status — GET /api/registration-status — public read of
 * whether sign-up is open, for the auth screens.
 *
 * Business logic:
 * - Deliberately not wrapped in `handle`: whoever asks has no session
 *   yet, so this and the better-auth catch-all are the only routes that
 *   answer anonymously, and it has to stay that way for the
 *   login/register screens to work.
 * - enabled = settings.registrationEnabled || isFirstUser(). The
 *   instance's first account may always register — lib/auth's
 *   user.create hook makes it admin and flips registrationEnabled off
 *   — and from then on the admin toggle alone decides.
 * - hasUsers is the same empty-user-table check inverted, letting a
 *   client tell a brand-new instance from a closed one.
 * - Both reads run in parallel, and the response is exactly these two
 *   booleans: no settings detail, no admin flag (that's /api/settings),
 *   no user data — which is what makes it safe unauthenticated.
 * - Read-only; with no handle() there's no error mapping either, so a
 *   db failure propagates to the framework rather than a json body.
 */
import { getSiteSettings, isFirstUser } from '../../../server/settings';

/* GET /api/registration-status — public; tells the auth screens whether
   sign-up is open (the first user always may register). */
export const GET = async () => {
  const [settings, first] = await Promise.all([
    getSiteSettings(),
    isFirstUser(),
  ]);
  return Response.json({
    enabled: settings.registrationEnabled || first,
    hasUsers: !first,
  });
};

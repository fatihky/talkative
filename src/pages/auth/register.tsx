/*
 * RegisterPage (/auth/register) — sign-up, gated on the server.
 *
 * Business logic:
 * - rendered dynamically: site settings and the user count are read per
 *   request.
 * - redirects to /auth/login unless this would be the very first user or
 *   registration is enabled, so a closed instance has no sign-up page.
 * - the same rule is enforced again in better-auth's user-create hook, so
 *   an already-open tab cannot create an account after registration closes.
 * - the first account created is made admin and turns registration off
 *   automatically; admins re-enable it from /settings/site, or add users
 *   from /settings/users instead.
 * - a signed-in visitor is redirected to / first; signed-out visitors get
 *   the bare auth layout.
 */
import { unstable_redirect } from 'waku/router/server';
import { getSession } from '../../server/auth';
import { getSiteSettings, isFirstUser } from '../../server/settings';
import { RegisterForm } from './register-form';

export default async function RegisterPage() {
  if (await getSession()) {
    throw unstable_redirect('/');
  }
  const [settings, first] = await Promise.all([
    getSiteSettings(),
    isFirstUser(),
  ]);
  /* the first user may always register; afterwards sign-up obeys the setting */
  if (!first && !settings.registrationEnabled) {
    throw unstable_redirect('/auth/login');
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950 p-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
            Create an account
          </h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Get started with Talkative today
          </p>
        </div>
        <RegisterForm />
      </div>
    </div>
  );
}

export const getConfig = async () => {
  return {
    render: 'dynamic',
  } as const;
};

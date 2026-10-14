/*
 * LoginPage (/auth/login) — the sign-in screen.
 *
 * Business logic:
 * - rendered dynamically: site settings and the user count are read per
 *   request, so the page follows a registration toggle flipped elsewhere.
 * - registrationEnabled = "no users yet" || settings.registrationEnabled;
 *   the first user may always register, later sign-ups obey the admin
 *   toggle. It only controls whether the sign-up link is offered.
 * - a signed-in visitor is redirected to / before anything renders, so the
 *   form never shows up inside the app chrome.
 */
import { unstable_redirect } from 'waku/router/server';
import { getSession } from '../../server/auth';
import { getSiteSettings, isFirstUser } from '../../server/settings';
import { LoginForm } from './login-form';

export default async function LoginPage() {
  if (await getSession()) {
    throw unstable_redirect('/');
  }
  const [settings, first] = await Promise.all([
    getSiteSettings(),
    isFirstUser(),
  ]);
  const registrationEnabled = first || settings.registrationEnabled;

  return (
    <div className="min-h-screen flex items-center justify-center bg-zinc-50 dark:bg-zinc-950 p-4">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight text-zinc-900 dark:text-zinc-100">
            Welcome back
          </h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            Sign in to your account to continue
          </p>
        </div>
        <LoginForm registrationEnabled={registrationEnabled} />
      </div>
    </div>
  );
}

export const getConfig = async () => {
  return {
    render: 'dynamic',
  } as const;
};

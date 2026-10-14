/*
 * AuthGuard — server-side gate wrapping every signed-in page.
 *
 * Business logic:
 * - Reads the session on the server and throws a redirect to /auth/login
 *   when there is none, so protected content is never rendered to an
 *   anonymous visitor.
 * - Wraps the app pages only; the public artifact page /a/<id> skips it on
 *   purpose.
 * - Passes children through untouched and keeps no client state.
 */
import { unstable_redirect } from 'waku/router/server';
import { getSession } from '../server/auth';

export async function AuthGuard({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  if (!session) {
    throw unstable_redirect('/auth/login');
  }

  return <>{children}</>;
}

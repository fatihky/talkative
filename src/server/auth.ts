/*
 * auth — the server's door into better-auth's session machinery.
 *
 * Business logic:
 * - getSession reads the incoming request headers via Waku's
 *   unstable_getHeaders and hands them to better-auth, which resolves the
 *   session cookie; it returns null (not a throw) for an anonymous
 *   visitor, so callers decide what "no session" means.
 * - requireAuth wraps getSession and throws 'Unauthorized' when there is
 *   no session — the hard gate for code that must never run anonymously.
 * - This is the only place the server touches request headers for auth;
 *   pages such as AuthGuard use the soft getSession and redirect, while
 *   requireAuth is the throwing variant for guarded server actions.
 */
import { unstable_getHeaders } from 'waku/router/server';
import { auth } from '../lib/auth';

export async function getSession() {
  const headers = unstable_getHeaders();
  const session = await auth.api.getSession({
    headers,
  });
  return session;
}

export async function requireAuth() {
  const session = await getSession();
  if (!session) {
    throw new Error('Unauthorized');
  }
  return session;
}

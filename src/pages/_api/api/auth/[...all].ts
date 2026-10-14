/*
 * auth/[...all] — GET/POST /api/auth/* — better-auth's catch-all
 * handler, and the door every session comes through.
 *
 * Business logic:
 * - deliberately not wrapped in `handle`: sign-in and sign-up have no
 *   session yet, so this and /api/registration-status are the only
 *   routes that answer anonymously. The request goes straight to
 *   auth.handler, which owns the sub-path routing, status codes,
 *   error bodies and cookies — nothing here validates, maps errors or
 *   touches the db (e62e10b).
 * - every path under /api/auth is resolved by better-auth itself
 *   (sign-up/email, sign-in/email, get-session, sign-out, …), which is
 *   why one catch-all file covers the whole surface and a new
 *   endpoint needs no new route. Only GET and POST are exported,
 *   which is all better-auth's API uses.
 * - this is the root of the rest of the API's auth: the session cookie
 *   set here is what getSession() reads, and every handle()-wrapped
 *   route answers 401 without it. There is no admin variant of this
 *   route — isAdmin is a column checked elsewhere, never a separate
 *   login.
 * - the sign-up policy lives in src/lib/auth.ts, not here: its
 *   user.create hook flags the first registered user isAdmin and turns
 *   registrationEnabled off, and refuses later sign-ups while
 *   registration is closed.
 * - baseURL and trustedOrigins come from BETTER_AUTH_URL and
 *   BETTER_AUTH_TRUSTED_ORIGINS; those decide which origins
 *   better-auth accepts cross-origin posts from, so a mis-set env
 *   shows up here as a rejected sign-in rather than as an app bug.
 * - no side effects of its own to keep in sync: deleting a user
 *   cascades their rows (chats, messages, artifacts, attachments,
 *   memories) through the schema — only the image files on disk need
 *   `pnpm uploads:gc` afterwards.
 */
import { auth } from '../../../../lib/auth';

export const GET = (req: Request) => auth.handler(req);
export const POST = (req: Request) => auth.handler(req);

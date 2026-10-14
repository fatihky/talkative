/*
 * no-trailing-slash — the app's only request middleware; Waku managed
 * mode auto-mounts the default export of every src/middleware/* file.
 *
 * Business logic:
 * - Exact rule (hono trimTrailingSlash, alwaysRedirect): a GET or HEAD
 *   request whose path ends in '/' — except '/' itself — is 301
 *   redirected to the same URL with the trailing slash stripped, query
 *   string preserved. alwaysRedirect makes this fire before routing,
 *   not only as a 404 fallback.
 * - Why: every page keeps one canonical URL, so '/c/slug/' can't
 *   become a second addressable copy of '/c/slug' (duplicate content,
 *   split bookmarks/cache entries).
 * - The commented block below is scaffold documentation for the
 *   opposite policy (appendTrailingSlash, skipping file-like paths);
 *   it is not active.
 */
import { trimTrailingSlash } from 'hono/trailing-slash';

export default () => trimTrailingSlash({ alwaysRedirect: true });

// Usage of appendTrailingSlash
/*
import { appendTrailingSlash } from 'hono/trailing-slash';

export default () =>
  appendTrailingSlash({
    alwaysRedirect: true,
    skip: (path) => /\.\w+$/.test(path),
  });
*/

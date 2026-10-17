/*
 * suggestions — GET /api/suggestions — the home screen's starter
 * prompts.
 *
 * Business logic:
 * - Session-only via `handle`, but no user data is read: the list is the
 *   fixed pinned + static set, identical for every caller, so nothing from
 *   a previous chat (its title or first prompt) ever leaks onto the home
 *   screen.
 * - Read-only, no query params: the set and order are fixed here and in
 *   the service.
 * - Errors map through `handle` (401 with no session, 500 on a db
 *   failure); the client treats a failure as "no suggestions".
 */
import { handle } from '../../../server/providers';
import { buildSuggestions } from '../../../server/suggestions';

/* GET /api/suggestions — pinned + static suggestions for the home screen */
export const GET = () =>
  handle(async () => Response.json(buildSuggestions()));

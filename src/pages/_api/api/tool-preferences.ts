/*
 * tool-preferences — GET/PUT /api/tool-preferences — the account-wide
 * default tool grants, backend picks, counts and concurrency caps.
 *
 * Business logic:
 * - Session-only via `handle` and scoped to the session user. These are
 *   the defaults new chats inherit, not per-chat state: a chat's own
 *   tool config travels with the chat, not through this route.
 * - GET is a thin wrapper over loadToolPreferences. Only tools the user
 *   has touched have a row, so the reply is four sparse maps (grants,
 *   providers, counts, concurrency) and the client fills the gaps from
 *   its own defaults.
 * - PUT parses, saves, then re-reads. parseToolPreferences rejects an
 *   unknown tool id, a non-boolean grant, a provider the tool doesn't
 *   offer and a non-integer count/concurrency (ValidationError → 400);
 *   saveToolPreferences upserts only the tools named in the body and
 *   only the fields present, leaving every other row untouched. A first
 *   row starts from the tool's default grant, so a provider-only change
 *   can't silently flip the tool on or off.
 * - The reply is a fresh load rather than the input echoed back, so the
 *   client's store matches what was actually stored.
 */
import { handle } from '../../../server/providers';
import {
  loadToolPreferences,
  parseToolPreferences,
  saveToolPreferences,
} from '../../../server/tool-preferences';

/* GET /api/tool-preferences — the user's saved grants and backend picks */
export const GET = () =>
  handle(async (userId) => Response.json(await loadToolPreferences(userId)));

/* PUT /api/tool-preferences — upserts the given tools, leaves the rest alone */
export const PUT = (req: Request) =>
  handle(async (userId) => {
    await saveToolPreferences(userId, parseToolPreferences(await req.json()));
    return Response.json(await loadToolPreferences(userId));
  });

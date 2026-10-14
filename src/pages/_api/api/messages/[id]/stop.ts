/*
 * MessageStop — POST /api/messages/:id/stop — cancel a live generation.
 *
 * Business logic:
 * - auth via handle(); :id must be a uuid (404 otherwise). the id is
 *   the assistant message the run was started for.
 * - stopRun(:id, userId) fires the run's AbortController only when the
 *   run exists, belongs to this user, and hasn't finalized; runs.ts
 *   turns the abort into final status 'stopped', settles in-flight
 *   tool calls as errors, and does the DB flush + 'done' broadcast —
 *   this route never touches the database.
 * - idempotent and ownership-safe by return value: {stopped: false}
 *   (still 200) for a foreign, finished or unknown run, so a
 *   double-click or a stale client never gets 403/404/500.
 * - the only cancel path: closing the SSE stream deliberately does not
 *   stop generation, since runs are detached from HTTP requests
 *   (7004fd0).
 */
import type { ApiContext } from 'waku/router';
import { isUuid, messageNotFound } from '../../../../../server/chats';
import { handle } from '../../../../../server/providers';
import { stopRun } from '../../../../../server/runs';

type Ctx = ApiContext<'/api/messages/[id]/stop'>;

/* POST /api/messages/:id/stop — the only way to cancel a generation; idempotent */
export const POST = (_req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return messageNotFound();
    return Response.json({ stopped: stopRun(params.id, userId) });
  });

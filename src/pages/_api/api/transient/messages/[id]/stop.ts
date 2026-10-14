/*
 * transient/messages/[id]/stop — POST /api/transient/messages/:id/stop —
 * cancel a live private-chat generation. identical semantics to the stored
 * variant: fires the run's AbortController, idempotent, never touches the db.
 */
import type { ApiContext } from 'waku/router';
import { isUuid, messageNotFound } from '../../../../../../server/chats';
import { handle } from '../../../../../../server/providers';
import { stopRun } from '../../../../../../server/runs';

type Ctx = ApiContext<'/api/transient/messages/[id]/stop'>;

export const POST = (_req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return messageNotFound();
    return Response.json({ stopped: stopRun(params.id, userId) });
  });

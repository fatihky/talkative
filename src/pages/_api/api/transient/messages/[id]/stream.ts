/*
 * transient/messages/[id]/stream — GET /api/transient/messages/:id/stream —
 * SSE playback of an in-memory private-chat reply.
 *
 * Business logic:
 * - auth via handle(); a non-uuid :id is 404. the reply has no database row,
 *   so the only source is the in-process run registry (server/runs.ts).
 * - identical event contract to GET /api/messages/:id/stream: `tool`, `thought`,
 *   `thought-delta`, `delta`, then one `done {status, error?, usage…}`. private
 *   chats never run tools, so in practice only `delta`/`done` arrive.
 * - a run that finished (kept KEEP_MS) replays from memory and closes at once;
 *   a run already evicted means the reply was lost with the process — 404, since
 *   there is nothing to fall back to.
 */
import type { ApiContext } from 'waku/router';
import { isUuid, messageNotFound } from '../../../../../../server/chats';
import { handle } from '../../../../../../server/providers';
import { getRun, subscribe } from '../../../../../../server/runs';
import { sseResponse } from '../../../../../../server/sse';

type Ctx = ApiContext<'/api/transient/messages/[id]/stream'>;

export const GET = (req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return messageNotFound();
    const run = getRun(params.id, userId);
    if (!run) return messageNotFound();

    const raw = Number(new URL(req.url).searchParams.get('offset') ?? 0);
    const offset = Number.isInteger(raw) && raw > 0 ? raw : 0;

    return sseResponse(req, (send, close) => {
      for (const call of run.toolCalls) send('tool', { call });
      for (const thought of run.thoughts) send('thought', { thought });
      const tail = run.text.slice(offset);
      if (tail) send('delta', { text: tail });
      if (run.final) {
        send('done', {
          ...run.final,
          usage: run.usage,
          ...(run.usageDetails ? { usageDetails: run.usageDetails } : {}),
          ...(run.routing ? { routing: run.routing } : {}),
          ...(run.refusal ? { refusal: run.refusal } : {}),
          ...(run.annotations.length > 0
            ? { annotations: run.annotations }
            : {}),
        });
        close();
        return undefined;
      }
      return subscribe(run, (e) => {
        if (e.type === 'delta') send('delta', { text: e.text });
        else if (e.type === 'tool') send('tool', { call: e.call });
        else if (e.type === 'thought') send('thought', { thought: e.thought });
        else if (e.type === 'thought-delta') {
          const { type: _, ...d } = e;
          send('thought-delta', d);
        } else {
          const { type: _, ...final } = e;
          send('done', final);
          close();
        }
      });
    });
  });

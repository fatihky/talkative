/*
 * MessageStream — GET /api/messages/:id/stream?offset=N — SSE playback
 * of an assistant reply, live from memory or stored in the DB.
 *
 * Business logic:
 * - auth via handle(); the uuid check plus userId-scoped getRun/
 *   findMessage mean a missing or foreign message reads as 404.
 * - offset must be a positive integer, else treated as 0. run text is
 *   append-only, so a reconnecting client resumes losslessly by
 *   passing how many characters it already received.
 * - live path: getRun() finds the in-process run (server/runs.ts), and
 *   the snapshot (known tool calls, closed thoughts, text tail) plus
 *   subscribe() are wired inside sseResponse's start callback — same
 *   tick, so no delta can fall between snapshot and subscription.
 *   events: `tool {call}` (clients upsert by id), `thought {thought}`
 *   (replace by step), `thought-delta {step, at, text}`, `notice
 *   {text}` (an adjustment worth telling the user, e.g. a clamped
 *   reasoning effort; not persisted), `delta
 *   {text}`, then exactly one `done {status, error?, usage…}` which
 *   closes the stream. a run that already finalized (kept KEEP_MS for
 *   late subscribers) replays wholly from memory and closes at once.
 * - stored path: no live run means the reply finished long ago or was
 *   orphaned by a server restart; settleOrphan() marks a still-
 *   'streaming' row 'interrupted' (nothing will ever finish it), then
 *   the row's toolCalls/thoughts/content are replayed with a synthetic
 *   done carrying status/error/usage/routing/latency/refusal/
 *   annotations.
 * - disconnecting only unsubscribes (sse.ts runs the cleanup on abort/
 *   cancel) — generation continues server-side; stopping it is
 *   POST …/stop's job. sse.ts heartbeats keep idle proxies from
 *   cutting long generations.
 */
import type { ApiContext } from 'waku/router';
import { getDb } from '../../../../../db';
import {
  findMessage,
  isUuid,
  messageNotFound,
} from '../../../../../server/chats';
import { handle } from '../../../../../server/providers';
import { getRun, settleOrphan, subscribe } from '../../../../../server/runs';
import { sseResponse } from '../../../../../server/sse';

type Ctx = ApiContext<'/api/messages/[id]/stream'>;

/*
 * GET /api/messages/:id/stream?offset=N — sse of an assistant reply from character N on.
 * events: `tool {call}` (every known call first, then each change), `thought {thought}`
 * (every known block first, then each as it closes), `thought-delta {step, at, text}`,
 * `notice {text}`, `delta {text}`, then one `done {status, error?}`. closing this connection never stops the generation;
 * reconnect with offset = text received so far to resume.
 */
export const GET = (req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return messageNotFound();
    const raw = Number(new URL(req.url).searchParams.get('offset') ?? 0);
    const offset = Number.isInteger(raw) && raw > 0 ? raw : 0;

    const run = getRun(params.id, userId);
    if (run) {
      /* snapshot and subscribe in the same tick so no delta falls between them */
      return sseResponse(req, (send, close) => {
        for (const call of run.toolCalls) send('tool', { call });
        for (const thought of run.thoughts) send('thought', { thought });
        if (run.notice) send('notice', { text: run.notice });
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
          else if (e.type === 'thought')
            send('thought', { thought: e.thought });
          else if (e.type === 'thought-delta') {
            const { type: _, ...d } = e;
            send('thought-delta', d);
          } else if (e.type === 'notice') send('notice', { text: e.text });
          else {
            const { type: _, ...final } = e;
            send('done', final);
            close();
          }
        });
      });
    }

    /* no live run: finished long ago, or orphaned by a server restart */
    const db = getDb();
    const m = await findMessage(db, userId, params.id);
    if (!m) return messageNotFound();
    await settleOrphan(db, m);
    return sseResponse(req, (send, close) => {
      for (const call of m.toolCalls as unknown[]) send('tool', { call });
      for (const thought of m.thoughts as unknown[])
        send('thought', { thought });
      const tail = m.content.slice(offset);
      if (tail) send('delta', { text: tail });
      send('done', {
        status: m.status,
        ...(m.error ? { error: m.error } : {}),
        ...(m.usage ? { usage: m.usage } : {}),
        ...(m.usageDetails ? { usageDetails: m.usageDetails } : {}),
        ...(m.routing ? { routing: m.routing } : {}),
        ...(m.latencyMs ? { latencyMs: m.latencyMs } : {}),
        ...(m.refusal ? { refusal: m.refusal } : {}),
        ...(m.annotations && (m.annotations as unknown[]).length > 0
          ? { annotations: m.annotations }
          : {}),
      });
      close();
      return undefined;
    });
  });

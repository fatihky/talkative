/*
 * Sse — the text/event-stream response wrapper behind the message
 * stream endpoint (the app's only sse route).
 *
 * Business logic:
 * - `: ping` comment frames every 15 s keep idle proxies from
 *   cutting a long generation; `x-accel-buffering: no` and
 *   `cache-control: no-cache, no-transform` stop nginx-style proxies
 *   from buffering or rewriting the stream.
 * - `start` gets a sender and a closer and may return a cleanup —
 *   the stream route returns the run's unsubscribe — which runs
 *   exactly once, whether the server closes, the client disconnects
 *   (req.signal abort) or the stream is cancelled.
 * - closing is idempotent and sending after close is a no-op, so run
 *   events racing a disconnect can't throw or resurrect the stream;
 *   ctrl.close() is guarded because the client may have cancelled
 *   first.
 * - if the connection died while `start` itself ran, the returned
 *   cleanup is invoked immediately instead of being leaked.
 * - frames are `event: <name>` plus a single json `data:` line —
 *   JSON.stringify escapes newlines, so a payload can never split
 *   across frames.
 */
const HEARTBEAT_MS = 15_000;

export type SseSend = (event: string, data: unknown) => void;

/**
 * text/event-stream response. `start` gets a sender and a closer and may return a
 * cleanup, which runs once on close, client disconnect or stream cancel.
 */
export const sseResponse = (
  req: Request,
  start: (send: SseSend, close: () => void) => (() => void) | undefined,
): Response => {
  const enc = new TextEncoder();
  let finish = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      let closed = false;
      let cleanup: (() => void) | undefined;
      /* comment frames keep idle proxies from cutting a long generation */
      const beat = setInterval(() => {
        if (!closed) ctrl.enqueue(enc.encode(': ping\n\n'));
      }, HEARTBEAT_MS);
      finish = () => {
        if (closed) return;
        closed = true;
        clearInterval(beat);
        req.signal.removeEventListener('abort', finish);
        cleanup?.();
        try {
          ctrl.close();
        } catch {
          /* already cancelled by the client */
        }
      };
      const send: SseSend = (event, data) => {
        if (!closed)
          ctrl.enqueue(
            enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
      };
      req.signal.addEventListener('abort', finish);
      cleanup = start(send, finish);
      if (closed) cleanup?.();
    },
    cancel() {
      finish();
    },
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      /* stops nginx-style proxies from buffering the stream */
      'x-accel-buffering': 'no',
    },
  });
};

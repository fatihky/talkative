/*
 * MessageAnswer — POST /api/messages/:id/answer — deliver the user's
 * answers to a blocked ask_user tool call.
 *
 * Business logic:
 * - auth via handle(); :id must be a uuid (404 otherwise). the id is
 *   the assistant reply whose ask_user call is waiting, not a
 *   question id — the pending map in server/tools/ask-user.ts is keyed
 *   by messageId/callId.
 * - body {callId, answers}: callId a non-empty string, answers a plain
 *   object (array rejected) of question id → answer string; every miss
 *   throws ValidationError → 400, malformed JSON → 400 via SyntaxError.
 * - each answer is trimmed; non-string and empty ones are skipped, any
 *   over ANSWER_MAX (4000) chars is rejected, more than MAX_ANSWERS
 *   (3) is rejected, and at least one must survive — the same budget
 *   ask_user gives the model, so a client can't smuggle unbounded text
 *   into the tool result.
 * - ownership is enforced twice: getRun(:id, userId) must find a live
 *   run belonging to this user and answerQuestion() must find the call
 *   still pending; either miss → 409 "no longer waiting" (the run
 *   finished, timed out, or was stopped).
 * - never touches the DB: resolving the pending promise lets the
 *   detached run continue, and the run's own flush persists the answer
 *   as the tool result.
 */
import type { ApiContext } from 'waku/router';
import { isUuid, messageNotFound } from '../../../../../server/chats';
import { handle, ValidationError } from '../../../../../server/providers';
import { getRun } from '../../../../../server/runs';
import { answerQuestion } from '../../../../../server/tools/ask-user';

type Ctx = ApiContext<'/api/messages/[id]/answer'>;

const ANSWER_MAX = 4000;
const MAX_ANSWERS = 3;

/*
 * POST /api/messages/:id/answer {callId, answers} — replies to an ask_user call that
 * reply :id is waiting on. `answers` is a record of question id → answer string.
 */
export const POST = (req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return messageNotFound();
    const body = (await req.json().catch(() => null)) as {
      callId?: unknown;
      answers?: unknown;
    } | null;
    const callId = typeof body?.callId === 'string' ? body.callId : '';
    if (!callId) throw new ValidationError('callId is required');
    if (
      !body?.answers ||
      typeof body.answers !== 'object' ||
      Array.isArray(body.answers)
    )
      throw new ValidationError('answers must be an object');
    const raw = body.answers as Record<string, unknown>;
    const answers: Record<string, string> = {};
    let count = 0;
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v !== 'string') continue;
      const trimmed = v.trim();
      if (!trimmed) continue;
      if (trimmed.length > ANSWER_MAX)
        throw new ValidationError(
          `answer for "${k}" exceeds ${ANSWER_MAX} characters`,
        );
      answers[k] = trimmed;
      count++;
      if (count > MAX_ANSWERS)
        throw new ValidationError(`too many answers (max ${MAX_ANSWERS})`);
    }
    if (count === 0)
      throw new ValidationError('at least one answer is required');
    if (
      !getRun(params.id, userId) ||
      !answerQuestion(params.id, callId, answers)
    )
      return Response.json(
        { error: 'that question is no longer waiting for an answer' },
        { status: 409 },
      );
    return Response.json({ ok: true });
  });
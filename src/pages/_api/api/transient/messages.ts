/*
 * transient/messages — POST /api/transient/messages — start an unsaved,
 * in-memory reply for a private chat. nothing is written to the database.
 *
 * Business logic:
 * - auth via handle() (401 without a session); the run still executes as the
 *   calling user so provider lookups and any ad-hoc tool credentials resolve.
 * - the client mints the assistant message id (the same shape the standard
 *   send flow uses) so it can stream the reply from
 *   GET /api/transient/messages/:id/stream before the server answers.
 * - the whole conversation up to this turn is posted as `history` (already
 *   shaped into user/assistant string turns by the client), so a private
 *   chat can regenerate its full context without a stored row. the newest
 *   turn is the user prompt being answered.
 * - tools are disabled by default for private chats: `tools` is always empty
 *   here, so the model never calls out and changing the composer tool
 *   selection can't affect account defaults.
 * - startRun(transient) reuses the streaming agent loop but skips every
 *   database flush/finalize, so the reply only ever lives in the in-process
 *   run registry and is lost on reload or server restart.
 */
import type { ApiContext } from 'waku/router';
import { parseGenerateInput } from '../../../../server/chats';
import { handle, ValidationError } from '../../../../server/providers';
import { startRun } from '../../../../server/runs';
import type { Turn } from '../../../../server/runs';

type Ctx = ApiContext<'/api/transient/messages'>;

/* cap the client-supplied history so a private chat can't replay unbounded context into a run */
const MAX_HISTORY_TURNS = 200;

const parseTurn = (v: unknown): Turn | null => {
  if (typeof v !== 'object' || v === null) return null;
  const t = v as Record<string, unknown>;
  if (t.role !== 'user' && t.role !== 'assistant') return null;
  const content = typeof t.content === 'string' ? t.content : '';
  /* assistant turns may carry replayed tool calls, but private chats never run tools */
  return { role: t.role, content };
};

const parseHistory = (v: unknown): Turn[] => {
  if (!Array.isArray(v))
    throw new ValidationError('history must be an array of turns');
  const turns = v
    .slice(0, MAX_HISTORY_TURNS)
    .map(parseTurn)
    .filter((t): t is Turn => t !== null);
  if (turns.length === 0 || turns.at(-1)?.role !== 'user')
    throw new ValidationError(
      'history must end with the user turn being answered',
    );
  return turns;
};

export const POST = (req: Request, _ctx: Ctx) =>
  handle(async (userId) => {
    const body = (await req.json()) as Record<string, unknown>;
    const { modelId, thinkingLevel } = parseGenerateInput(body);
    const history = parseHistory(body.history);

    const assistantId = crypto.randomUUID();

    startRun({
      messageId: assistantId,
      chatId: `private:${userId}`,
      userId,
      modelId,
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      history,
      tools: [],
      transient: true,
    });

    return Response.json(
      {
        assistant: {
          id: assistantId,
          parentId: null,
          role: 'assistant',
          content: '',
          status: 'streaming',
          modelId,
          createdAt: Date.now(),
        },
      },
      { status: 201 },
    );
  });

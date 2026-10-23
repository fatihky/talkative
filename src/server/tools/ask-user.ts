/*
 * tools/ask-user — pause the run to put multiple-choice questions to the
 * user and wait for the answers.
 *
 * Business logic:
 * - run() registers a pending resolver under `${messageId}/${callId}` and
 *   waits, leaving the tool step "running" in the stream; the key includes
 *   the message id because local providers reuse call ids across replies,
 *   and the map hangs on globalThis like the runs it belongs to.
 * - answerQuestion is how POST /api/messages/:id/answer releases the wait;
 *   it returns false when nothing is pending anymore, which the route turns
 *   into a 409 ("no longer waiting for an answer").
 * - the model gets JSON back: {status:'answered', answers} keyed by
 *   question id, or {status:'cancelled', timed_out:true} once the timeout
 *   fires — 120s by default, clamped to 60–240s so an unanswered question
 *   can't pin a run in memory forever; stopping the run rejects instead.
 * - the runner (runs.ts) rejects ask_user when it is mixed with other tool
 *   calls in one turn — it must be the only call, so the whole turn waits.
 * - normalizeAskUserRequest is the single validator: at most 3 questions
 *   (blank or malformed ones are skipped, and zero survivors throw), at
 *   most 3 options each with fewer than 2 dropping the options entirely
 *   (free-text only), and every string cut to its length cap.
 * - allow_other defaults to true globally with a per-question override,
 *   controlling whether the card offers a typed answer.
 * - multi_select defaults to false globally with a per-question override;
 *   when set the card lets the user toggle several options and the answer
 *   comes back as one string with the labels joined by ", ". such an
 *   answer can be longer than a single label or contain newlines, so the
 *   answer route's budget accounts for it.
 * - keyless 'default' backend: always available when granted (on by
 *   default); its only side effect is the pause itself.
 */
import type { ServerTool } from './index';

/* an unanswered question shouldn't pin a run in memory forever */
const MIN_TIMEOUT = 60_000;
const MAX_TIMEOUT = 240_000;
const DEFAULT_TIMEOUT = 120_000;
const MAX_QUESTIONS = 3;
const MAX_OPTIONS = 3;
const MIN_OPTIONS = 2;
const MAX_ID_LEN = 64;
const MAX_HEADER_LEN = 48;
const MAX_QUESTION_LEN = 500;
const MAX_LABEL_LEN = 80;
const MAX_DESC_LEN = 240;

type Pending = (answer: Record<string, string>) => void;

/*
 * questions waiting on the user, keyed `${messageId}/${callId}` because local providers
 * reuse call ids across replies. cached on globalThis like the runs they belong to.
 */
const g = globalThis as typeof globalThis & {
  __questions?: Map<string, Pending>;
};
g.__questions ??= new Map<string, Pending>();
const pending = g.__questions;

const keyOf = (messageId: string, callId: string) => `${messageId}/${callId}`;

/** hands the user's answers to a waiting ask_user call; false when nothing is waiting */
export const answerQuestion = (
  messageId: string,
  callId: string,
  answers: Record<string, string>,
): boolean => {
  const p = pending.get(keyOf(messageId, callId));
  if (!p) return false;
  p(answers);
  return true;
};

type QuestionOption = { label: string; description: string };
type QuestionDef = {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  allow_other: boolean;
  multi_select: boolean;
};

const clampTimeout = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_TIMEOUT;
  if (v < MIN_TIMEOUT || v > MAX_TIMEOUT) return DEFAULT_TIMEOUT;
  return v;
};

const truncateStr = (v: unknown, max: number): string => {
  if (typeof v !== 'string') return '';
  return v.slice(0, max);
};

/** validates and normalizes the raw args into a clean question set */
export const normalizeAskUserRequest = (
  args: Record<string, unknown>,
): { questions: QuestionDef[]; allow_other: boolean; timeout_ms: number } => {
  const globalAllowOther =
    typeof args.allow_other === 'boolean' ? args.allow_other : true;
  const globalMultiSelect =
    typeof args.multi_select === 'boolean' ? args.multi_select : false;
  const timeout_ms = clampTimeout(args.timeout_ms);

  const rawQuestions = Array.isArray(args.questions)
    ? args.questions
    : [{ ...args }];

  const questions: QuestionDef[] = [];
  for (let i = 0; i < Math.min(rawQuestions.length, MAX_QUESTIONS); i++) {
    const q = rawQuestions[i] as Record<string, unknown> | undefined;
    if (!q || typeof q !== 'object') continue;

    const id = truncateStr(q.id, MAX_ID_LEN) || `q${i + 1}`;
    const header = truncateStr(q.header, MAX_HEADER_LEN) || `Question ${i + 1}`;
    const question = truncateStr(q.question, MAX_QUESTION_LEN);
    if (!question.trim()) continue;

    const localAllowOther =
      typeof q.allow_other === 'boolean' ? q.allow_other : globalAllowOther;
    const localMultiSelect =
      typeof q.multi_select === 'boolean'
        ? q.multi_select
        : globalMultiSelect;

    let options: QuestionOption[] = [];
    if (Array.isArray(q.options)) {
      for (const o of q.options) {
        if (typeof o === 'string') {
          options.push({ label: o.slice(0, MAX_LABEL_LEN), description: '' });
        } else if (o && typeof o === 'object') {
          const opt = o as Record<string, unknown>;
          const label = truncateStr(opt.label, MAX_LABEL_LEN);
          if (!label.trim()) continue;
          options.push({
            label,
            description: truncateStr(opt.description, MAX_DESC_LEN),
          });
        }
        if (options.length >= MAX_OPTIONS) break;
      }
    }
    /* need at least 2 options for multiple choice; drop options if fewer */
    if (options.length < MIN_OPTIONS) options = [];

    questions.push({
      id,
      header,
      question,
      options,
      allow_other: localAllowOther,
      multi_select: localMultiSelect,
    });
  }

  if (questions.length === 0)
    throw new Error('at least one valid question is required');
  return { questions, allow_other: globalAllowOther, timeout_ms };
};

export const askUser: ServerTool = {
  id: 'ask_user',
  description:
    'Ask the user 1–3 multiple-choice clarifying questions and wait for the answers before continuing. ' +
    "Use when the next step depends on the user's intent, a preference, or a tradeoff you cannot safely infer. " +
    'Each question has 2–3 options; the first option is marked as Recommended. ' +
    'The user can also type a free-text answer unless allow_other is false. ' +
    'Set multi_select to let the user pick several options at once (the answer comes back as the labels joined by ", "). ' +
    'Do not use for small talk or when you can proceed without clarification.',
  parameters: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        description: '1–3 clarifying questions',
        items: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              maxLength: MAX_ID_LEN,
              description: 'unique identifier for this question',
            },
            header: {
              type: 'string',
              maxLength: MAX_HEADER_LEN,
              description: 'short tab header; defaults to "Question N"',
            },
            question: {
              type: 'string',
              maxLength: MAX_QUESTION_LEN,
              description: 'the question text',
            },
            options: {
              type: 'array',
              minItems: MIN_OPTIONS,
              maxItems: MAX_OPTIONS,
              description: '2–3 choices; the first is marked Recommended',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', maxLength: MAX_LABEL_LEN },
                  description: { type: 'string', maxLength: MAX_DESC_LEN },
                },
                required: ['label'],
              },
            },
            allow_other: {
              type: 'boolean',
              description: 'override the global allow_other for this question',
            },
            multi_select: {
              type: 'boolean',
              description:
                'let the user pick several options (labels joined by ", "); override the global multi_select',
            },
          },
          required: ['question'],
        },
      },
      allow_other: {
        type: 'boolean',
        description:
          'allow free-text answers by default; per-question setting overrides',
      },
      multi_select: {
        type: 'boolean',
        description:
          'allow picking several options by default; per-question setting overrides',
      },
      timeout_ms: {
        type: 'number',
        description: `how long the prompt stays open (${MIN_TIMEOUT}–${MAX_TIMEOUT} ms); defaults to ${DEFAULT_TIMEOUT}`,
      },
    },
    required: ['questions'],
  },
  backends: () => [{ id: 'default' }],
  async run(args, ctx) {
    const { timeout_ms } = normalizeAskUserRequest(args);
    const key = keyOf(ctx.messageId, ctx.callId);
    const answers = await new Promise<Record<string, string> | null>(
      (resolve, reject) => {
        const done = () => {
          clearTimeout(timer);
          ctx.signal.removeEventListener('abort', onAbort);
          pending.delete(key);
        };
        const onAbort = () => {
          done();
          reject(ctx.signal.reason);
        };
        const timer = setTimeout(() => {
          done();
          resolve(null);
        }, timeout_ms);
        pending.set(key, (a) => {
          done();
          resolve(a);
        });
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener('abort', onAbort, { once: true });
      },
    );
    if (answers === null) {
      return JSON.stringify({
        status: 'cancelled',
        answers: {},
        timed_out: true,
      });
    }
    return JSON.stringify({ status: 'answered', answers });
  },
};

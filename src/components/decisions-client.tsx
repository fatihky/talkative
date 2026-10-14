/*
 * DecisionsClient / DecisionEditor — the /decisions run list and one run's
 * editor.
 *
 * Business logic:
 * - The list is the user's stored runs, newest edit first; it refetches on
 *   mount (never cached locally) and marks a run that never answered, or
 *   whose last attempt failed, so the row says what opening it will show.
 * - "New decision" mints a run client-side and routes into its editor before
 *   anything is stored: a draft only reaches the database when it is run.
 * - The editor sets the UI context to 'new' and the route drops the composer
 *   (a decision is a form, not a chat), and leaving it flushes a pending
 *   debounced rename so the last keystrokes reach the server.
 * - The model picker puts `kind: 'decision'` and `kind: 'systemone'` models
 *   first — System One models answer /systemone and decision models answer
 *   /decisions — but lists chat models too, since OpenAI and Bifrost serve
 *   decisions from an ordinary model. A provider with no endpoint for the
 *   chosen kind (ollama for decisions, bifrost/openai for System One) is
 *   refused by the route and its message lands in the run's error.
 * - Questions are edited in place: the type control swaps the shape and seeds
 *   the two entries its type needs, choices and levels grow and shrink, and a
 *   name is an identifier because it is the key the answer comes back under.
 * - Run is gated on decisionProblems(), so the button explains the first
 *   missing piece instead of spending a request on a 400; a failure — upstream
 *   or transport — shows in the error card while the stored run keeps its
 *   questions.
 * - Answers render per question in the order asked: the headline value, its
 *   bar, the distribution the provider reported, and confidence. A score's
 *   probabilities are labelled from its legend, falling back to the question's
 *   own levels.
 */
'use client';

import { useEffect } from 'react';
import { Link, useParams_UNSTABLE } from 'waku/router/client';
import {
  answerBar,
  answerValue,
  DECISION_EXAMPLES,
  decisionProblems,
  levelLabels,
  pct,
  QUESTION_TYPES,
} from '../lib/decisions';
import { $fmt, fullTimestamp, kfmt, timeAgo } from '../lib/format';
import { I } from '../lib/icons';
import { Tip } from '../lib/popover';
import { actions, useDecisionsStore, useModelsStore } from '../stores';
import type {
  DecisionAnswer,
  DecisionQuestion,
  DecisionQuestionType,
  Model,
} from '../types';
import { SegmentedControl } from '../ui/primitives';
import { DecisionModelPicker } from './decision-model-picker';

const inputCls =
  'h-8 w-full rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] px-2 text-[13px] outline-none focus:border-[var(--accent)]';
const areaCls =
  'w-full resize-y rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] p-2 text-[13px] leading-[1.55] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--accent)]';

/* ── list ─────────────────────────────────────────────────────────── */

export function DecisionsClient() {
  const items = useDecisionsStore((s) => s.items);
  const status = useDecisionsStore((s) => s.status);
  const error = useDecisionsStore((s) => s.error);
  const models = useModelsStore((s) => s.items);

  useEffect(() => {
    actions.setContext('new');
    void actions.loadDecisions();
  }, []);

  return (
    <main className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4 sm:px-6">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-[20px] leading-[1.35] font-semibold">
              Decisions
            </h1>
            <p className="mt-1 text-[12px] muted">
              Evaluate text against typed questions — a probability, one of your
              choices, or a score across ordered levels — with a decision model.
            </p>
          </div>
          <button
            type="button"
            className="ctl-primary h-7 shrink-0"
            onClick={() => actions.newDecision()}
          >
            <I n="plus" s={13} /> New decision
          </button>
        </div>

        {error && (
          <div className="text-[12px] text-[var(--danger)]" role="alert">
            {error}
          </div>
        )}

        {items.length === 0 && status !== 'ready' && (
          <div className="py-10 text-center text-[12px] muted">
            {status === 'loading'
              ? 'Loading decisions…'
              : error
                ? 'Couldn’t load decisions.'
                : 'No decisions yet.'}
          </div>
        )}

        <section className="flex flex-col gap-2 border-t border-[var(--border)] pt-3">
          <div className="sec-label">Examples</div>
          <p className="text-[11px] muted">
            Start from one of these, then swap in your own input and model.
          </p>
          <div className="flex flex-col">
            {DECISION_EXAMPLES.map((e) => (
              <button
                key={e.title}
                type="button"
                className="flex flex-col gap-0.5 rounded-[6px] px-2.5 py-2 text-left hover:bg-[var(--sunken)]"
                onClick={() => actions.newDecisionFromExample(e)}
              >
                <span className="text-[13px]">{e.title}</span>
                <span className="text-[11px] muted">{e.blurb}</span>
              </button>
            ))}
          </div>
        </section>

        <div className="flex flex-col">
          {items.map((r) => (
            <Link
              key={r.id}
              to={`/decisions/${r.id}`}
              className="flex items-center gap-2 rounded-[6px] px-2.5 py-2 hover:bg-[var(--sunken)]"
            >
              <I n="decision" s={13} className="shrink-0 text-[var(--text-3)]" />
              <span className="min-w-0 flex-1 truncate text-[13px]">
                {r.title || 'Untitled decision'}
              </span>
              {r.kind === 'systemone' && (
                <span className="shrink-0 rounded-[4px] bg-[var(--sunken)] px-1 text-[10px] muted">
                  system one
                </span>
              )}
              <span className="num hidden shrink-0 text-[11px] muted sm:inline">
                {modelName(models, r.modelId)}
              </span>
              <span className="num shrink-0 text-[11px] muted">
                {r.questions.length} q
              </span>
              {r.error ? (
                <span className="shrink-0 text-[10px] text-[var(--danger)]">
                  failed
                </span>
              ) : (
                !r.answers && (
                  <span className="shrink-0 text-[10px] muted">not run</span>
                )
              )}
              <span
                className="num w-[62px] shrink-0 text-right text-[11px] muted"
                title={fullTimestamp(r.updatedAt)}
              >
                {timeAgo(r.updatedAt)}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </main>
  );
}

const modelName = (models: Model[], id: string): string =>
  models.find((m) => m.id === id)?.shortName ?? id;

/* ── editor ───────────────────────────────────────────────────────── */

export function DecisionEditor() {
  const params = useParams_UNSTABLE({ from: '/decisions/[slug]' });
  const id = params?.slug ?? '';
  const draft = useDecisionsStore((s) => s.draft);
  const run = useDecisionsStore((s) => s.items.find((r) => r.id === id) ?? null);
  const status = useDecisionsStore((s) => s.status);
  const loadError = useDecisionsStore((s) => s.error);
  const running = useDecisionsStore((s) => s.running);
  const runError = useDecisionsStore((s) => s.runError);
  const models = useModelsStore((s) => s.items);

  useEffect(() => {
    actions.setContext('new');
    /* the cached draft answers at once; a deep link resolves once the list lands */
    actions.openDecision(id);
    void actions.loadDecisions().then(() => actions.openDecision(id));
    /* don't leave the last keystrokes waiting on the debounce */
    return () => {
      actions.flushDecisionTitle();
      actions.flushDecisionDraft();
    };
  }, [id]);

  if (!draft)
    return (
      <main className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4 sm:px-6">
        <div className="mx-auto w-full max-w-[720px] py-10 text-center text-[12px] muted">
          {status === 'loading' || status === 'idle'
            ? 'Loading…'
            : status === 'error'
              ? `Couldn’t load decisions — ${loadError ?? 'unknown error'}`
              : 'Decision not found'}
        </div>
      </main>
    );

  const problems = decisionProblems(draft);
  const answers = run?.answers ?? [];

  return (
    <main className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4 sm:px-6">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-3">
        <div className="flex items-center gap-2">
          <Link
            to="/decisions"
            className="ctl-icon border-transparent bg-transparent text-[var(--text-2)] hover:bg-[var(--sunken)]"
            aria-label="Back to decisions"
          >
            <I n="arrow-left" s={14} />
          </Link>
          <input
            value={draft.title}
            aria-label="Decision title"
            placeholder="Untitled decision"
            onChange={(e) => actions.setDecisionTitle(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-[16px] font-semibold outline-none placeholder:text-[var(--text-3)]"
          />
          <div className="flex shrink-0 items-center gap-2">
            {problems.length > 0 && !running && (
              <span className="hidden max-w-[220px] truncate text-[11px] muted sm:inline">
                {problems[0]}
              </span>
            )}
            <button
              type="button"
              className="ctl-primary h-7"
              disabled={running || problems.length > 0}
              onClick={() => void actions.runDecision()}
            >
              <I n={running ? 'retry' : 'play'} s={12} />
              {running ? 'Running…' : 'Run'}
            </button>
            <Tip label="Delete decision" side="bottom">
              <button
                type="button"
                className="ctl-icon border-transparent bg-transparent text-[var(--text-2)] hover:bg-[var(--sunken)]"
                aria-label="Delete decision"
                onClick={async () => {
                  const ok = await actions.confirm({
                    title: `Delete “${draft.title || 'Untitled decision'}”?`,
                    body: 'The run, its questions and its answers are removed. This can’t be undone.',
                    confirmLabel: 'Delete',
                    danger: true,
                  });
                  if (!ok) return;
                  await actions.deleteDecision(draft.id);
                  actions.navigateTo('/decisions');
                }}
              >
                <I n="trash" s={13} />
              </button>
            </Tip>
          </div>
        </div>

        <section className="flex flex-col gap-1.5">
          <div className="sec-label">Model</div>
          <DecisionModelPicker />
          <p className="text-[11px] muted">
            System One models answer via each provider’s /systemone endpoint;
            decision models go through /decisions, and OpenAI and Bifrost also
            answer from an ordinary chat model.
          </p>
        </section>

        <section className="flex flex-col gap-1.5">
          <div className="sec-label">Input</div>
          <textarea
            value={draft.input}
            aria-label="Input to evaluate"
            placeholder="The text every question is asked about…"
            rows={6}
            onChange={(e) => actions.setDecisionInput(e.target.value)}
            className={areaCls}
          />
        </section>

        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <div className="sec-label">
              Questions
              <span className="num ml-1.5 text-[11px] font-normal">
                {draft.questions.length}
              </span>
            </div>
            <div className="ml-auto flex items-center gap-1">
              {QUESTION_TYPES.map((t) => (
                <button
                  key={t.type}
                  type="button"
                  className="ctl h-6 px-2 text-[11px]"
                  title={t.hint}
                  onClick={() => actions.addDecisionQuestion(t.type)}
                >
                  <I n="plus" s={11} /> {t.label}
                </button>
              ))}
            </div>
          </div>
          {draft.questions.map((q, i) => (
            /* keyed by position: a card keyed on its name would remount — and lose
               focus — on every keystroke of the name field */
            <QuestionCard key={i} q={q} index={i} />
          ))}
          {draft.questions.length === 0 && (
            <div className="py-4 text-center text-[12px] muted">
              No questions yet.
            </div>
          )}
        </section>

        {runError && (
          <div
            className="rounded-[8px] border border-[var(--danger)] bg-[var(--panel)] p-3"
            role="alert"
            aria-live="assertive"
          >
            <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--danger)]">
              <I n="alert" s={14} /> Decision failed
            </div>
            <div className="num mt-1 text-[11px] muted">{runError}</div>
          </div>
        )}

        {answers.length > 0 && (
          <section className="flex flex-col gap-2">
            <div className="sec-label">Answers</div>
            {draft.questions.map((q, i) => {
              const a = answers.find((x) => x.name === q.name);
              return a ? <AnswerCard key={i} a={a} q={q} /> : null;
            })}
            {/* an answer whose question was edited away still gets shown */}
            {answers
              .filter((a) => !draft.questions.some((q) => q.name === a.name))
              .map((a) => (
                <AnswerCard key={a.name} a={a} q={undefined} />
              ))}
          </section>
        )}

        {run && (run.usage || run.latencyMs !== undefined) && (
          <div className="num flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border)] pt-2 text-[11px] muted">
            {run.usage && (
              <span>
                {kfmt(run.usage.promptTokens)} in ·{' '}
                {kfmt(run.usage.completionTokens)} out
              </span>
            )}
            {run.usage?.costUsd !== undefined && (
              <span>{$fmt(run.usage.costUsd)}</span>
            )}
            {run.latencyMs !== undefined && <span>{run.latencyMs} ms</span>}
            <span className="break-all">{modelName(models, run.modelId)}</span>
            <span title={fullTimestamp(run.updatedAt)}>
              {timeAgo(run.updatedAt)}
            </span>
          </div>
        )}
      </div>
    </main>
  );
}

/* ── question ─────────────────────────────────────────────────────── */

function QuestionCard({ q, index }: { q: DecisionQuestion; index: number }) {
  const setChoices = (choices: DecisionQuestion['choices']) =>
    actions.updateDecisionQuestion(index, { choices });
  const setLevels = (levels: DecisionQuestion['levels']) =>
    actions.updateDecisionQuestion(index, { levels });

  return (
    <div className="flex flex-col gap-2 rounded-[8px] border border-[var(--border)] bg-[var(--panel)] p-2.5">
      <div className="flex items-center gap-2">
        <input
          value={q.name}
          aria-label="Question name"
          placeholder="name"
          spellCheck={false}
          onChange={(e) => actions.renameDecisionQuestion(index, e.target.value)}
          className="num h-7 w-[150px] shrink-0 rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] px-2 text-[12px] outline-none focus:border-[var(--accent)]"
        />
        <SegmentedControl
          ariaLabel={`Question type for ${q.name || 'this question'}`}
          value={q.type}
          options={QUESTION_TYPES.map((t) => ({
            value: t.type,
            label: t.label,
          }))}
          disabled={false}
          onChange={(v) =>
            actions.setDecisionQuestionType(index, v as DecisionQuestionType)
          }
        />
        <Tip
          label={QUESTION_TYPES.find((t) => t.type === q.type)?.hint ?? ''}
          side="top"
        >
          <span className="muted flex shrink-0 items-center">
            <I n="info" s={13} />
          </span>
        </Tip>
        <button
          type="button"
          className="ctl-icon ml-auto shrink-0 border-transparent bg-transparent text-[var(--text-2)] hover:bg-[var(--sunken)]"
          aria-label={`Remove question ${q.name || index + 1}`}
          onClick={() => actions.removeDecisionQuestion(index)}
        >
          <I n="trash" s={13} />
        </button>
      </div>

      <textarea
        value={q.instructions}
        aria-label={`Instructions for ${q.name}`}
        placeholder="What should the model decide?"
        rows={2}
        onChange={(e) =>
          actions.updateDecisionQuestion(index, {
            instructions: e.target.value,
          })
        }
        className={areaCls}
      />

      {q.type === 'predicate' && (
        <div className="flex flex-col gap-1.5">
          {(['true', 'false'] as const).map((k) => (
            <label key={k} className="flex items-center gap-2 text-[11px]">
              <span className="num w-9 shrink-0 muted">{k}</span>
              <input
                value={q.criteria?.[k] ?? ''}
                aria-label={`What counts as ${k}`}
                placeholder={`What counts as ${k} (optional)`}
                onChange={(e) =>
                  actions.updateDecisionQuestion(index, {
                    criteria: { ...q.criteria, [k]: e.target.value },
                  })
                }
                className={inputCls}
              />
            </label>
          ))}
          <p className="text-[11px] muted">
            Read by Typesafe-backed models (Bifrost, OpenRouter) only.
          </p>
        </div>
      )}

      {q.type === 'choice' && (
        <div className="flex flex-col gap-1.5">
          {(q.choices ?? []).map((c, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <input
                value={c.value}
                aria-label={`Choice ${i + 1} value`}
                placeholder="value"
                onChange={(e) =>
                  setChoices(
                    (q.choices ?? []).map((x, j) =>
                      j === i ? { ...x, value: e.target.value } : x,
                    ),
                  )
                }
                className={`${inputCls} w-[150px] shrink-0`}
              />
              <input
                value={c.description ?? ''}
                aria-label={`Choice ${i + 1} description`}
                placeholder="When does it apply? (optional)"
                onChange={(e) =>
                  setChoices(
                    (q.choices ?? []).map((x, j) =>
                      j === i ? { ...x, description: e.target.value } : x,
                    ),
                  )
                }
                className={inputCls}
              />
              <button
                type="button"
                className="ctl-icon shrink-0 border-transparent bg-transparent text-[var(--text-2)] hover:bg-[var(--sunken)]"
                aria-label={`Remove choice ${i + 1}`}
                onClick={() =>
                  setChoices((q.choices ?? []).filter((_, j) => j !== i))
                }
              >
                <I n="x" s={12} />
              </button>
            </div>
          ))}
          <div>
            <button
              type="button"
              className="ctl h-6 px-2 text-[11px]"
              onClick={() => setChoices([...(q.choices ?? []), { value: '' }])}
            >
              <I n="plus" s={11} /> Add option
            </button>
          </div>
        </div>
      )}

      {q.type === 'score' && (
        <div className="flex flex-col gap-1.5">
          {(q.levels ?? []).map((l, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="num w-4 shrink-0 text-right text-[11px] muted">
                {i}
              </span>
              <input
                value={l.label}
                aria-label={`Level ${i} label`}
                placeholder="label"
                onChange={(e) =>
                  setLevels(
                    (q.levels ?? []).map((x, j) =>
                      j === i ? { ...x, label: e.target.value } : x,
                    ),
                  )
                }
                className={`${inputCls} w-[150px] shrink-0`}
              />
              <input
                value={l.description ?? ''}
                aria-label={`Level ${i} description`}
                placeholder="What belongs here? (optional)"
                onChange={(e) =>
                  setLevels(
                    (q.levels ?? []).map((x, j) =>
                      j === i ? { ...x, description: e.target.value } : x,
                    ),
                  )
                }
                className={inputCls}
              />
              <button
                type="button"
                className="ctl-icon shrink-0 border-transparent bg-transparent text-[var(--text-2)] hover:bg-[var(--sunken)]"
                aria-label={`Remove level ${i}`}
                onClick={() =>
                  setLevels((q.levels ?? []).filter((_, j) => j !== i))
                }
              >
                <I n="x" s={12} />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="ctl h-6 px-2 text-[11px]"
              onClick={() => setLevels([...(q.levels ?? []), { label: '' }])}
            >
              <I n="plus" s={11} /> Add level
            </button>
            <span className="text-[11px] muted">
              Ordered lowest first; the score is the weighted index.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── answer ───────────────────────────────────────────────────────── */

function AnswerCard({
  a,
  q,
}: {
  a: DecisionAnswer;
  q: DecisionQuestion | undefined;
}) {
  const bar = answerBar(a);
  const dist = a.probabilities ?? [];
  const labels = levelLabels(a, q);
  return (
    <div className="flex flex-col gap-1.5 rounded-[8px] border border-[var(--border)] bg-[var(--panel)] p-2.5">
      <div className="flex items-center gap-2">
        <span className="num min-w-0 truncate text-[12px] muted">{a.name}</span>
        <span className="shrink-0 rounded-[4px] bg-[var(--sunken)] px-1 text-[10px] muted">
          {a.type}
        </span>
        {a.type === 'refusal' ? (
          <span className="ml-auto shrink-0 text-[12px] text-[var(--warn)]">
            The model declined to answer
          </span>
        ) : (
          <span className="num ml-auto shrink-0 text-[15px] font-semibold">
            {answerValue(a)}
          </span>
        )}
        {a.confidence !== undefined && (
          <span className="num shrink-0 text-[11px] muted">
            conf {pct(a.confidence)}
          </span>
        )}
      </div>
      {bar !== null && <Bar v={bar} label={`${a.name} confidence`} />}
      {dist.length > 0 && (
        <div className="mt-0.5 flex flex-col gap-1">
          {dist.map((p, i) => {
            const label =
              typeof p.value === 'number'
                ? (labels[String(p.value)] ?? p.label ?? String(p.value))
                : String(p.value);
            return (
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <span className="w-[150px] shrink-0 truncate" title={label}>
                  {label}
                </span>
                <Bar v={p.probability} label={`${label} probability`} grow />
                <span className="num w-[38px] shrink-0 text-right muted">
                  {pct(p.probability)}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {q?.instructions && (
        <p className="mt-0.5 text-[11px] muted">{q.instructions}</p>
      )}
    </div>
  );
}

function Bar({
  v,
  label,
  grow = false,
}: {
  v: number;
  label: string;
  grow?: boolean;
}) {
  const pctg = Math.max(0, Math.min(1, v)) * 100;
  return (
    <span
      className={`block h-1.5 overflow-hidden rounded-[2px] bg-[var(--sunken)] ${grow ? 'flex-1' : 'w-full'}`}
      role="progressbar"
      aria-valuenow={Math.round(pctg)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span
        className="block h-full"
        style={{ width: `${pctg}%`, background: 'var(--accent)' }}
      />
    </span>
  );
}

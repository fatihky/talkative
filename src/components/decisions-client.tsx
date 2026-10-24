/*
 * DecisionsClient / DecisionEditor — the /decisions run list and one run's
 * editor.
 *
 * Business logic:
 * - The list is the user's stored runs, newest edit first; it refetches on
 *   mount (never cached locally). Each row previews its answers, or says the
 *   run never answered or that its last attempt failed, so the row tells you
 *   what opening it will show.
 * - Examples are the empty state: with no runs they are the page; once runs
 *   exist they fold into a "Start from an example" disclosure under the list.
 * - "New decision" mints a run client-side and routes into its editor before
 *   anything is stored: a draft only reaches the database when it is run, so
 *   deleting one that was never run only discards it.
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
 *   the two entries its type needs, choices and levels grow and shrink within
 *   the server's limits, and a name is an identifier because it is the key the
 *   answer comes back under.
 * - The stored run's stats (tokens, cost, latency, model, time) sit under the
 *   title, and the results summary plus "Run again" sit right below the
 *   header, so what the last run cost and decided is always at the top.
 * - Run (or ⌘/Ctrl+Enter) is gated on decisionProblems(): the first missing
 *   piece is spelled out under the header instead of spending a request on a
 *   400; a failure — upstream or transport — shows in the error card right
 *   there while the stored run keeps its questions.
 * - An answer renders inside the card of the question it answers (matched by
 *   name): the headline value, its bar, the distribution the provider
 *   reported, and confidence. A score's headline names its nearest level, and
 *   its probabilities are labelled from its legend, falling back to the
 *   question's own levels. An answer whose question was renamed or removed is
 *   still listed below the questions.
 * - Answers belong to the stored run, so once the input, model or questions
 *   drift from it they are dimmed and marked stale until the next run.
 */
'use client';

import { useEffect } from 'react';
import { Link, useParams_UNSTABLE } from 'waku/router/client';
import {
  answerBar,
  answerValue,
  DECISION_EXAMPLES,
  type DecisionDraft,
  decisionProblems,
  levelLabels,
  MAX_DECISION_CHOICES,
  MAX_DECISION_LEVELS,
  MAX_DECISION_QUESTIONS,
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
  DecisionRun,
  Model,
} from '../types';
import { SegmentedControl } from '../ui/primitives';
import { DecisionModelPicker } from './decision-model-picker';

const inputCls =
  'h-8 w-full rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] px-2 text-[13px] outline-none focus:border-[var(--accent)]';
const areaCls =
  'w-full resize-y rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] p-2 text-[13px] leading-[1.55] outline-none placeholder:text-[var(--text-3)] focus:border-[var(--accent)]';
const smallBtnCls =
  'ctl inline-flex h-6 items-center gap-1 px-2 text-[11px] disabled:opacity-50';
const iconBtnCls =
  'ctl-icon shrink-0 border-transparent bg-transparent text-[var(--text-2)] hover:bg-[var(--sunken)]';
const pageCls = 'scroll-thin min-h-0 flex-1 overflow-y-auto p-4 sm:px-6';
const colCls = 'mx-auto flex w-full max-w-[720px] flex-col';

const modelName = (models: Model[], id: string): string =>
  models.find((m) => m.id === id)?.shortName ?? id;

/** a score's nearest level label, when one is known */
const scoreLevel = (
  a: DecisionAnswer,
  q: DecisionQuestion | undefined,
): string | undefined =>
  a.type === 'score' && a.score !== undefined
    ? levelLabels(a, q)[String(Math.round(a.score))]
    : undefined;

/** the answer's headline, with a score's level name in front of its index */
const headline = (a: DecisionAnswer, q: DecisionQuestion | undefined) => {
  const level = scoreLevel(a, q);
  return level ? `${level} · ${answerValue(a)}` : answerValue(a);
};

/** the stored run no longer reflects what is on screen */
const drifted = (d: DecisionDraft, r: DecisionRun): boolean =>
  d.input !== r.input ||
  d.modelId !== r.modelId ||
  JSON.stringify(d.questions) !== JSON.stringify(r.questions);

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

  const empty = items.length === 0;
  const settled = status === 'ready' || status === 'error';

  return (
    <main className={pageCls}>
      <div className={`${colCls} gap-4`}>
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
            Couldn’t load decisions — {error}
          </div>
        )}

        {empty && !settled && (
          <div className="py-10 text-center text-[12px] muted">
            Loading decisions…
          </div>
        )}

        {!empty && (
          <section className="flex flex-col gap-1">
            <div className="sec-label">
              Runs
              <span className="num ml-1.5 text-[11px] font-normal">
                {items.length}
              </span>
            </div>
            <div className="flex flex-col">
              {items.map((r) => (
                <RunRow key={r.id} r={r} models={models} />
              ))}
            </div>
          </section>
        )}

        {empty && settled ? (
          <section className="flex flex-col gap-2">
            <div className="sec-label">Start from an example</div>
            <p className="text-[11px] muted">
              No decisions yet. Open one of these, then swap in your own input
              and model — or start blank with New decision.
            </p>
            <ExampleList />
          </section>
        ) : (
          !empty && (
            <details className="group border-t border-[var(--border)] pt-3">
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] muted hover:text-[var(--text)] [&::-webkit-details-marker]:hidden">
                <I
                  n="chevron-right"
                  s={12}
                  className="transition-transform group-open:rotate-90"
                />
                Start from an example
              </summary>
              <div className="mt-2">
                <ExampleList />
              </div>
            </details>
          )
        )}
      </div>
    </main>
  );
}

function RunRow({ r, models }: { r: DecisionRun; models: Model[] }) {
  const preview = (r.answers ?? [])
    .map((a) => {
      const q = r.questions.find((x) => x.name === a.name);
      return `${a.name} ${a.type === 'refusal' ? 'refused' : headline(a, q)}`;
    })
    .join(' · ');
  return (
    <Link
      to={`/decisions/${r.id}`}
      className="flex items-start gap-2 rounded-[6px] px-2.5 py-2 hover:bg-[var(--sunken)]"
    >
      <I
        n="decision"
        s={13}
        className="mt-[3px] shrink-0 text-[var(--text-3)]"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
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
          <span
            className="num w-[62px] shrink-0 text-right text-[11px] muted"
            title={fullTimestamp(r.updatedAt)}
          >
            {timeAgo(r.updatedAt)}
          </span>
        </div>
        <div className="num truncate text-[11px] muted">
          {r.error ? (
            <span className="text-[var(--danger)]">Failed — {r.error}</span>
          ) : preview ? (
            preview
          ) : (
            `Not run · ${r.questions.length} question${r.questions.length === 1 ? '' : 's'}`
          )}
        </div>
      </div>
    </Link>
  );
}

function ExampleList() {
  return (
    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
      {DECISION_EXAMPLES.map((e) => (
        <button
          key={e.title}
          type="button"
          className="flex flex-col gap-0.5 rounded-[6px] border border-[var(--border)] px-2.5 py-2 text-left hover:bg-[var(--sunken)]"
          onClick={() => actions.newDecisionFromExample(e)}
        >
          <span className="text-[13px]">{e.title}</span>
          <span className="text-[11px] muted">{e.blurb}</span>
        </button>
      ))}
    </div>
  );
}

/* ── editor ───────────────────────────────────────────────────────── */

export function DecisionEditor() {
  const params = useParams_UNSTABLE({ from: '/decisions/[slug]' });
  const id = params?.slug ?? '';
  const draft = useDecisionsStore((s) => s.draft);
  const run = useDecisionsStore(
    (s) => s.items.find((r) => r.id === id) ?? null,
  );
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
      <main className={pageCls}>
        <div className={`${colCls} py-10 text-center text-[12px] muted`}>
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
  /* answers that still match a question on screen, for the summary strip */
  const results = answers.filter((a) =>
    draft.questions.some((q) => q.name === a.name),
  );
  const stale = answers.length > 0 && !!run && drifted(draft, run);
  const orphans = answers.filter(
    (a) => !draft.questions.some((q) => q.name === a.name),
  );
  const atMax = draft.questions.length >= MAX_DECISION_QUESTIONS;

  return (
    <main
      className={pageCls}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void actions.runDecision();
        }
      }}
    >
      <div className={`${colCls} gap-4`}>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Link
              to="/decisions"
              className={iconBtnCls}
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
            {results.length === 0 && (
              <Tip label="Run · ⌘↵" side="bottom">
                <button
                  type="button"
                  className="ctl-primary h-7 shrink-0"
                  disabled={running || problems.length > 0}
                  onClick={() => void actions.runDecision()}
                >
                  {running ? (
                    <span className="block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  ) : (
                    <I n="play" s={12} />
                  )}
                  {running ? 'Running…' : 'Run'}
                </button>
              </Tip>
            )}
            <DeleteButton id={draft.id} title={draft.title} stored={!!run} />
          </div>
          {problems.length > 0 && !running && (
            <p className="pl-9 text-[11px] muted" aria-live="polite">
              To run: {problems[0]}
              {problems.length > 1 && ` (+${problems.length - 1} more)`}
            </p>
          )}
          {/* the stored run's cost and timing, right under the title */}
          {run && (run.usage || run.latencyMs !== undefined) && (
            <div className="num flex flex-wrap items-center gap-x-3 gap-y-1 pl-9 text-[11px] muted">
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
              <span className="break-all">
                {modelName(models, run.modelId)}
              </span>
              <span title={fullTimestamp(run.updatedAt)}>
                {timeAgo(run.updatedAt)}
              </span>
            </div>
          )}
        </div>

        {results.length > 0 && (
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <ResultsSummary
                answers={answers}
                questions={draft.questions}
                stale={stale}
              />
            </div>
            <div className="flex shrink-0 items-end justify-end">
              <Tip label="Run · ⌘↵" side="bottom">
                <button
                  type="button"
                  className="ctl-primary h-7 shrink-0"
                  disabled={running || problems.length > 0}
                  onClick={() => void actions.runDecision()}
                >
                  {running ? (
                    <span className="block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  ) : (
                    <I n="play" s={12} />
                  )}
                  {running ? 'Running…' : 'Run again'}
                </button>
              </Tip>
            </div>
          </div>
        )}

        {runError && (
          <div
            className="rounded-[8px] border border-[var(--danger)] bg-[var(--panel)] p-3"
            role="alert"
            aria-live="assertive"
          >
            <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--danger)]">
              <I n="alert" s={14} /> Decision failed
            </div>
            <div className="num mt-1 text-[11px] break-words muted">
              {runError}
            </div>
          </div>
        )}

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
                {draft.questions.length}/{MAX_DECISION_QUESTIONS}
              </span>
            </div>
            {stale && (
              <span className="ml-auto text-[11px] text-[var(--warn)]">
                Edited since the last run — answers are stale
              </span>
            )}
          </div>
          {draft.questions.map((q, i) => (
            /* keyed by position: a card keyed on its name would remount — and lose
               focus — on every keystroke of the name field */
            <QuestionCard
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              key={i}
              q={q}
              index={i}
              answer={answers.find((a) => a.name === q.name)}
              stale={stale}
            />
          ))}
          {draft.questions.length === 0 && (
            <div className="rounded-[8px] border border-dashed border-[var(--border)] py-4 text-center text-[12px] muted">
              No questions yet — add one below.
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1">
            {QUESTION_TYPES.map((t) => (
              <Tip key={t.type} label={t.hint} side="top">
                <button
                  type="button"
                  className={smallBtnCls}
                  disabled={atMax}
                  onClick={() => actions.addDecisionQuestion(t.type)}
                >
                  <I n="plus" s={11} /> {t.label}
                </button>
              </Tip>
            ))}
            {atMax && (
              <span className="ml-1 text-[11px] muted">
                {MAX_DECISION_QUESTIONS} questions per run at most
              </span>
            )}
          </div>
        </section>

        {orphans.length > 0 && (
          <section className="flex flex-col gap-2">
            <div className="sec-label">Answers without a question</div>
            <p className="text-[11px] muted">
              From the last run, under names no current question has.
            </p>
            {orphans.map((a) => (
              <div
                key={a.name}
                className="rounded-[8px] border border-[var(--border)] bg-[var(--panel)] p-2.5"
              >
                <AnswerBlock a={a} q={undefined} stale named />
              </div>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}

function DeleteButton({
  id,
  title,
  stored,
}: {
  id: string;
  title: string;
  stored: boolean;
}) {
  const label = stored ? 'Delete decision' : 'Discard draft';
  return (
    <Tip label={label} side="bottom">
      <button
        type="button"
        className={iconBtnCls}
        aria-label={label}
        onClick={async () => {
          const ok = await actions.confirm({
            title: stored
              ? `Delete “${title || 'Untitled decision'}”?`
              : 'Discard this draft?',
            body: stored
              ? 'The run, its questions and its answers are removed. This can’t be undone.'
              : 'It was never run, so nothing is stored — the input and questions are thrown away.',
            confirmLabel: stored ? 'Delete' : 'Discard',
            danger: true,
          });
          if (!ok) return;
          await actions.deleteDecision(id);
          actions.navigateTo('/decisions');
        }}
      >
        <I n="trash" s={13} />
      </button>
    </Tip>
  );
}

/* ── question ─────────────────────────────────────────────────────── */

function QuestionCard({
  q,
  index,
  answer,
  stale,
}: {
  q: DecisionQuestion;
  index: number;
  answer: DecisionAnswer | undefined;
  stale: boolean;
}) {
  const update = (
    patch: Parameters<typeof actions.updateDecisionQuestion>[1],
  ) => actions.updateDecisionQuestion(index, patch);
  const choices = q.choices ?? [];
  const levels = q.levels ?? [];

  return (
    <div className="flex flex-col rounded-[8px] border border-[var(--border)] bg-[var(--panel)] p-2.5">
      <details className="group" open>
        <summary className="flex cursor-pointer list-none flex-col gap-1 [&::-webkit-details-marker]:hidden">
          <div className="flex items-center gap-2">
            <I
              n="chevron-right"
              s={13}
              className="shrink-0 text-[var(--text-2)] transition-transform group-open:rotate-90"
            />
            <input
              value={q.name}
              aria-label="Question name"
              placeholder="name"
              spellCheck={false}
              onChange={(e) =>
                actions.renameDecisionQuestion(index, e.target.value)
              }
              className="num h-7 w-[150px] min-w-0 shrink rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] px-2 text-[12px] outline-none focus:border-[var(--accent)]"
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
                actions.setDecisionQuestionType(
                  index,
                  v as DecisionQuestionType,
                )
              }
            />
            <Tip
              label={QUESTION_TYPES.find((t) => t.type === q.type)?.hint ?? ''}
              side="top"
            >
              <span className="muted hidden shrink-0 items-center sm:flex">
                <I n="info" s={13} />
              </span>
            </Tip>
            <button
              type="button"
              className={`${iconBtnCls} ml-auto`}
              aria-label={`Remove question ${q.name || index + 1}`}
              onClick={(e) => {
                e.preventDefault();
                actions.removeDecisionQuestion(index);
              }}
            >
              <I n="trash" s={13} />
            </button>
          </div>
          {/* collapsed preview: the question's instructions trimmed to one line */}
          <span
            className="pl-5 text-[12px] muted truncate group-open:hidden"
            title={q.instructions || undefined}
          >
            {q.instructions.trim() || 'No instructions yet'}
          </span>
        </summary>

        <div className="mt-2 flex flex-col gap-2">
          <textarea
            value={q.instructions}
            aria-label={`Instructions for ${q.name}`}
            placeholder="What should the model decide?"
            rows={2}
            onChange={(e) => update({ instructions: e.target.value })}
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
                      update({
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
            <EntryList
              rows={choices.map((c) => ({ key: c.value, desc: c.description }))}
              keyPlaceholder="value"
              descPlaceholder="When does it apply? (optional)"
              noun="option"
              max={MAX_DECISION_CHOICES}
              onKey={(i, value) =>
                update({
                  choices: choices.map((x, j) =>
                    j === i ? { ...x, value } : x,
                  ),
                })
              }
              onDesc={(i, description) =>
                update({
                  choices: choices.map((x, j) =>
                    j === i ? { ...x, description } : x,
                  ),
                })
              }
              onRemove={(i) =>
                update({ choices: choices.filter((_, j) => j !== i) })
              }
              onAdd={() => update({ choices: [...choices, { value: '' }] })}
            />
          )}

          {q.type === 'score' && (
            <EntryList
              rows={levels.map((l) => ({ key: l.label, desc: l.description }))}
              keyPlaceholder="label"
              descPlaceholder="What belongs here? (optional)"
              noun="level"
              numbered
              max={MAX_DECISION_LEVELS}
              hint="Ordered lowest first; the score is the weighted index."
              onKey={(i, label) =>
                update({
                  levels: levels.map((x, j) => (j === i ? { ...x, label } : x)),
                })
              }
              onDesc={(i, description) =>
                update({
                  levels: levels.map((x, j) =>
                    j === i ? { ...x, description } : x,
                  ),
                })
              }
              onRemove={(i) =>
                update({ levels: levels.filter((_, j) => j !== i) })
              }
              onAdd={() => update({ levels: [...levels, { label: '' }] })}
            />
          )}

          {answer && (
            <div className="border-t border-[var(--border)] pt-2">
              <AnswerBlock a={answer} q={q} stale={stale} />
            </div>
          )}
        </div>
      </details>
    </div>
  );
}

/* a choice's options or a score's levels: a short key, an optional description */
function EntryList({
  rows,
  keyPlaceholder,
  descPlaceholder,
  noun,
  numbered = false,
  max,
  hint,
  onKey,
  onDesc,
  onRemove,
  onAdd,
}: {
  rows: { key: string; desc: string | undefined }[];
  keyPlaceholder: string;
  descPlaceholder: string;
  noun: string;
  numbered?: boolean;
  max: number;
  hint?: string;
  onKey: (i: number, v: string) => void;
  onDesc: (i: number, v: string) => void;
  onRemove: (i: number) => void;
  onAdd: () => void;
}) {
  const full = rows.length >= max;
  return (
    <div className="flex flex-col gap-1.5">
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: keyed by position so editing a row's key doesn't remount its inputs
        <div key={i} className="flex items-center gap-1.5">
          {numbered && (
            <span className="num w-4 shrink-0 text-right text-[11px] muted">
              {i}
            </span>
          )}
          <input
            value={r.key}
            aria-label={`${noun} ${numbered ? i : i + 1} ${keyPlaceholder}`}
            placeholder={keyPlaceholder}
            onChange={(e) => onKey(i, e.target.value)}
            className={`${inputCls} w-[150px] min-w-0 shrink`}
          />
          <input
            value={r.desc ?? ''}
            aria-label={`${noun} ${numbered ? i : i + 1} description`}
            placeholder={descPlaceholder}
            onChange={(e) => onDesc(i, e.target.value)}
            className={inputCls}
          />
          <button
            type="button"
            className={iconBtnCls}
            aria-label={`Remove ${noun} ${numbered ? i : i + 1}`}
            onClick={() => onRemove(i)}
          >
            <I n="x" s={12} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={smallBtnCls}
          disabled={full}
          onClick={onAdd}
        >
          <I n="plus" s={11} /> Add {noun}
        </button>
        <span className="text-[11px] muted">
          {full ? `${max} ${noun}s at most.` : hint}
        </span>
      </div>
    </div>
  );
}

/* ── answer ───────────────────────────────────────────────────────── */

function AnswerBlock({
  a,
  q,
  stale,
  named = false,
}: {
  a: DecisionAnswer;
  q: DecisionQuestion | undefined;
  stale: boolean;
  /* outside a question card nothing else says which question this answers */
  named?: boolean;
}) {
  const bar = answerBar(a);
  const dist = a.probabilities ?? [];
  const labels = levelLabels(a, q);
  return (
    <div
      className={`flex flex-col gap-1.5 ${stale ? 'opacity-55' : ''}`}
      title={stale ? 'From the last run, before your edits' : undefined}
    >
      <div className="flex items-center gap-2">
        {named ? (
          <span className="num min-w-0 truncate text-[12px] muted">
            {a.name}
          </span>
        ) : (
          <span className="sec-label">Answer</span>
        )}
        {named && (
          <span className="shrink-0 rounded-[4px] bg-[var(--sunken)] px-1 text-[10px] muted">
            {a.type}
          </span>
        )}
        {a.type === 'refusal' ? (
          <span className="ml-auto shrink-0 text-[12px] text-[var(--warn)]">
            The model declined to answer
          </span>
        ) : (
          <span className="num ml-auto min-w-0 truncate text-[15px] font-semibold">
            {headline(a, q)}
          </span>
        )}
        {a.confidence !== undefined && (
          <span className="num shrink-0 text-[11px] muted">
            conf {pct(a.confidence)}
          </span>
        )}
      </div>
      {bar !== null && (
        <Bar
          v={bar}
          label={
            a.type === 'predicate'
              ? `${a.name} probability true`
              : `${a.name} confidence`
          }
        />
      )}
      {dist.length > 0 && (
        <div className="mt-0.5 flex flex-col gap-1">
          {dist.map((p, i) => {
            const label =
              typeof p.value === 'number'
                ? (labels[String(p.value)] ?? p.label ?? String(p.value))
                : String(p.value);
            const picked = a.type === 'choice' && p.value === a.choice;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: read-only rows that are never reordered
              <div key={i} className="flex items-center gap-2 text-[11px]">
                <span
                  className={`w-[150px] shrink-0 truncate ${picked ? 'font-medium' : ''}`}
                  title={label}
                >
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

/* ── results summary ──────────────────────────────────────────────── */

/* a one-line glance at every answer, shown at the top once a run succeeds */
function ResultsSummary({
  answers,
  questions,
  stale,
}: {
  answers: DecisionAnswer[];
  questions: DecisionQuestion[];
  stale: boolean;
}) {
  return (
    <section
      className={`flex flex-col gap-2 rounded-[8px] border border-[var(--border)] bg-[var(--panel)] p-2.5 ${stale ? 'opacity-55' : ''}`}
      aria-label="Results"
    >
      <div className="flex items-center gap-2">
        <div className="sec-label">Results</div>
        {stale && (
          <span className="ml-auto text-[11px] text-[var(--warn)]">
            Stale — from before your edits
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1">
        {answers.map((a) => {
          const q = questions.find((x) => x.name === a.name);
          const bar = answerBar(a);
          return (
            <div
              key={a.name}
              className="flex items-center gap-2 rounded-[6px] bg-[var(--sunken)] px-2 py-1.5"
            >
              <span
                className="num w-[88px] shrink-0 truncate text-[11px] muted"
                title={a.name}
              >
                {a.name}
              </span>
              <span className="num min-w-0 flex-1 truncate text-[13px] font-semibold">
                {a.type === 'refusal' ? 'Refused' : headline(a, q)}
              </span>
              {bar !== null && (
                <span className="flex w-[72px] shrink-0 items-center">
                  <Bar
                    v={bar}
                    label={`${a.name} ${a.type === 'predicate' ? 'probability' : 'confidence'}`}
                  />
                </span>
              )}
              {a.confidence !== undefined && (
                <span className="num shrink-0 text-[11px] muted">
                  {pct(a.confidence)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

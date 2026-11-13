/*
 * DecisionsClient / DecisionEditor — the /decisions run list and one run's
 * neo-brutalist editor (BUILD / RESULTS).
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
 *   debounced rename and unstored draft cache.
 * - Questions are navigated one at a time through the Question Rail (chips
 *   `01 P`, `02 C`, `03 S`, plus add and two-step delete) shared by BUILD and
 *   RESULTS. Switching a question's type carries choices/levels across where
 *   compatible, and rows can be reordered up/down within server limits.
 * - Run (or ⌘/Ctrl+Enter) validates via decisionProblemDetails(): a missing
 *   field switches to BUILD, selects the offending question, shakes/flags the
 *   control, and spells out the problem in the footer; a completed evaluation
 *   switches straight to RESULTS to show the summary strip and per-option /
 *   per-level probability bars.
 * - Answers belong to the stored run, so once the input, model or questions
 *   drift from it they are marked stale until the next run (or reverted with
 *   two-step Revert).
 */
'use client';

import {
  type TextareaHTMLAttributes,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Link, useParams_UNSTABLE } from 'waku/router/client';
import {
  answerBar,
  answerValue,
  DECISION_EXAMPLES,
  DECISION_NAME_RE,
  type DecisionDraft,
  type DecisionProblemField,
  decisionProblemDetails,
  levelLabels,
  MAX_DECISION_CHOICES,
  MAX_DECISION_CRITERION,
  MAX_DECISION_INPUT,
  MAX_DECISION_INSTRUCTIONS,
  MAX_DECISION_LEVELS,
  MAX_DECISION_OPTION_KEY,
  MAX_DECISION_QUESTIONS,
  MAX_DECISION_TITLE,
  MIN_DECISION_CHOICES,
  MIN_DECISION_LEVELS,
  pct,
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
import { DecisionModelPicker } from './decision-model-picker';

const CHOICE_LETTERS = 'ABCDEFGHIJKLMNOPQRST';

const TYPE_ORDER: DecisionQuestionType[] = ['predicate', 'choice', 'score'];

const TYPE_TAG: Record<DecisionQuestionType, string> = {
  predicate: 'P',
  choice: 'C',
  score: 'S',
};

const TYPE_NAME: Record<DecisionQuestionType, string> = {
  predicate: 'PREDICATE',
  choice: 'CHOICE',
  score: 'SCORE',
};

const TYPE_HINT: Record<DecisionQuestionType, string> = {
  predicate: 'PROBABILITY THAT THE STATEMENT HOLDS',
  choice: 'MODEL PICKS ONE VALUE FROM YOUR LIST',
  score: 'ORDERED LOWEST FIRST · WEIGHTED INDEX',
};

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

const choiceBadge = (i: number): string => CHOICE_LETTERS[i] ?? String(i + 1);

/* ── auto-growing textarea ────────────────────────────────────────── */

function AutoTextarea({
  value,
  growKey,
  maxPx,
  textareaRef,
  ...rest
}: {
  value: string;
  growKey?: string | number;
  maxPx?: number;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value'>) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = textareaRef ?? localRef;

  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    const border = el.offsetHeight - el.clientHeight;
    const next = el.scrollHeight + border;
    el.style.height = `${maxPx ? Math.min(maxPx, next) : next}px`;
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: value and growKey drive height recalculation
  useLayoutEffect(() => {
    resize();
  }, [value, growKey, maxPx]);

  useEffect(() => {
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  });

  return <textarea ref={ref} rows={1} value={value} {...rest} />;
}

/* ── list (/decisions) ────────────────────────────────────────────── */

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
    <main className="dec-stage scroll-thin">
      <div className="dec-card">
        <header className="dec-head">
          <div className="dec-brand">
            <span className="dec-mark" />
            <h1>DECISIONS</h1>
          </div>
          <div className="dec-head-actions">
            <button
              type="button"
              className="dec-btn solid"
              onClick={() => actions.newDecision()}
            >
              <I n="plus" s={12} w={2.6} />
              <span>NEW DECISION</span>
            </button>
          </div>
        </header>

        <div className="dec-meta">
          <span>
            PREDICATE &middot; CHOICE &middot; SCORE &middot; MODEL EVALUATION
          </span>
          <span>
            {settled
              ? `${items.length} ${items.length === 1 ? 'RUN' : 'RUNS'}`
              : 'LOADING…'}
          </span>
        </div>

        {error && (
          <div className="dec-error-banner" role="alert">
            <I n="alert" s={14} w={2.2} />
            <div>
              <div className="dec-error-title">COULDN’T LOAD DECISIONS</div>
              <div className="dec-error-body">{error}</div>
            </div>
          </div>
        )}

        {empty && !settled && (
          <div className="dec-sec py-8 text-center">
            <span className="dec-status">LOADING DECISIONS…</span>
          </div>
        )}

        {!empty && (
          <section className="dec-sec">
            <div className="dec-sec-head">
              <span className="dec-sec-label">
                <b>01</b> / STORED RUNS
                <span className="dec-cnum">{items.length}</span>
              </span>
              <span className="dec-hint">NEWEST EDIT FIRST</span>
            </div>
            <div>
              {items.map((r, i) => (
                <RunRow key={r.id} r={r} index={i} models={models} />
              ))}
            </div>
          </section>
        )}

        {empty && settled ? (
          <section className="dec-sec">
            <div className="dec-sec-head">
              <span className="dec-sec-label">
                <b>01</b> / START FROM AN EXAMPLE
                <span className="dec-cnum">{DECISION_EXAMPLES.length}</span>
              </span>
              <span className="dec-hint">PICK A TEMPLATE OR START BLANK</span>
            </div>
            <p className="mb-2.5 text-[12px] text-[var(--dec-muted)]">
              Evaluate text against typed questions — a probability, one of your
              choices, or a score across ordered levels — with a decision model.
            </p>
            <ExampleList />
          </section>
        ) : (
          !empty && (
            <section className="dec-sec">
              <details className="dec-details">
                <summary className="dec-sec-label">
                  <I n="chevron-right" s={12} w={2.4} className="dec-chev" />
                  <span>
                    <b>02</b> / START FROM AN EXAMPLE
                  </span>
                  <span className="dec-cnum">{DECISION_EXAMPLES.length}</span>
                </summary>
                <div className="mt-2.5">
                  <ExampleList />
                </div>
              </details>
            </section>
          )
        )}
      </div>
    </main>
  );
}

function RunRow({
  r,
  index,
  models,
}: {
  r: DecisionRun;
  index: number;
  models: Model[];
}) {
  const preview = (r.answers ?? [])
    .map((a) => {
      const q = r.questions.find((x) => x.name === a.name);
      return `${a.name}: ${a.type === 'refusal' ? 'refused' : headline(a, q)}`;
    })
    .join(' · ');

  return (
    <Link to={`/decisions/${r.id}`} className="dec-run-row">
      <span className="dec-badge">{String(index + 1).padStart(2, '0')}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-bold">
            {r.title || 'Untitled decision'}
          </span>
          {r.kind === 'systemone' && (
            <span className="dec-model-tag">SYS1</span>
          )}
          <span className="dec-count hidden shrink-0 sm:inline">
            {modelName(models, r.modelId)}
          </span>
          <span
            className="dec-count shrink-0"
            title={fullTimestamp(r.updatedAt)}
          >
            {timeAgo(r.updatedAt)}
          </span>
        </div>
        <div className="truncate font-mono text-[11px] text-[var(--dec-muted)]">
          {r.error ? (
            <span className="font-semibold text-[var(--dec-danger)]">
              FAILED &mdash; {r.error}
            </span>
          ) : preview ? (
            preview
          ) : (
            `NOT RUN · ${r.questions.length} QUESTION${r.questions.length === 1 ? '' : 'S'}`
          )}
        </div>
      </div>
      <I
        n="chevron-right"
        s={13}
        w={2.4}
        className="shrink-0 text-[var(--dec-muted)]"
      />
    </Link>
  );
}

function ExampleList() {
  return (
    <div className="dec-examples-grid">
      {DECISION_EXAMPLES.map((e) => (
        <button
          key={e.title}
          type="button"
          className="dec-example"
          onClick={() => actions.newDecisionFromExample(e)}
        >
          <div className="flex w-full items-center justify-between gap-2">
            <span className="truncate text-[13px] font-bold">{e.title}</span>
            <span className="flex shrink-0 gap-1 font-mono text-[9px] font-semibold text-[var(--dec-muted)]">
              {e.questions.map((q) => TYPE_TAG[q.type]).join('·')}
            </span>
          </div>
          <span className="text-[11.5px] leading-[1.4] text-[var(--dec-muted)]">
            {e.blurb}
          </span>
        </button>
      ))}
    </div>
  );
}

/* ── editor (/decisions/[slug]) ───────────────────────────────────── */

type FlagState = {
  field: DecisionProblemField;
  questionIndex?: number | undefined;
  message: string;
  nonce: number;
  shaking: boolean;
};

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

  const [mode, setMode] = useState<'build' | 'results'>('build');
  const [activeIdx, setActiveIdx] = useState(0);
  const [delArmed, setDelArmed] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const [flag, setFlag] = useState<FlagState | null>(null);

  const seededIdRef = useRef<string>('');
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const keyRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const delTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flagTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    actions.setContext('new');
    setActiveIdx(0);
    setDelArmed(false);
    setResetArmed(false);
    setFlag(null);
    actions.openDecision(id);
    void actions.loadDecisions().then(() => actions.openDecision(id));
    return () => {
      actions.flushDecisionTitle();
      actions.flushDecisionDraft();
    };
  }, [id]);

  /* open on RESULTS when arriving at an evaluated, undrifted run; BUILD otherwise */
  useEffect(() => {
    if (!draft || draft.id !== id || seededIdRef.current === id) return;
    /* wait for list load when a deep-linked run isn't in memory yet */
    if (!run && (status === 'idle' || status === 'loading')) return;
    seededIdRef.current = id;
    const hasFreshAnswers =
      !!run && (run.answers?.length ?? 0) > 0 && !drifted(draft, run);
    setMode(hasFreshAnswers ? 'results' : 'build');
  }, [draft, run, status, id]);

  useEffect(
    () => () => {
      if (delTimerRef.current) clearTimeout(delTimerRef.current);
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      if (flagTimerRef.current) clearTimeout(flagTimerRef.current);
    },
    [],
  );

  const qLen = draft?.questions.length ?? 0;
  const safeIdx = Math.max(0, Math.min(activeIdx, Math.max(0, qLen - 1)));

  /* keep the active question chip scrolled into view */
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-center when question count or tab changes too
  useEffect(() => {
    const wrap = chipsRef.current;
    const chip = wrap?.children[safeIdx] as HTMLElement | undefined;
    if (wrap && chip) {
      wrap.scrollLeft = Math.max(0, chip.offsetLeft - 24);
    }
  }, [safeIdx, qLen, mode]);

  if (!draft) {
    return (
      <main className="dec-stage scroll-thin">
        <div className="dec-card">
          <div className="dec-sec py-10 text-center">
            <span className="dec-status">
              {status === 'loading' || status === 'idle'
                ? 'LOADING DECISION…'
                : status === 'error'
                  ? `COULDN’T LOAD DECISIONS — ${loadError ?? 'UNKNOWN ERROR'}`
                  : 'DECISION NOT FOUND'}
            </span>
          </div>
        </div>
      </main>
    );
  }

  const problemDetails = decisionProblemDetails(draft);
  const answers = run?.answers ?? [];
  const results = answers.filter((a) =>
    draft.questions.some((q) => q.name === a.name),
  );
  const stale = answers.length > 0 && !!run && drifted(draft, run);
  const orphans = answers.filter(
    (a) => !draft.questions.some((q) => q.name === a.name),
  );
  const atMax = draft.questions.length >= MAX_DECISION_QUESTIONS;
  const activeQuestion = draft.questions[safeIdx];
  const activeAnswer = activeQuestion
    ? answers.find((a) => a.name === activeQuestion.name)
    : undefined;

  const clearFlag = () => {
    if (flagTimerRef.current) clearTimeout(flagTimerRef.current);
    setFlag(null);
  };

  const disarmDel = () => {
    if (delTimerRef.current) clearTimeout(delTimerRef.current);
    setDelArmed(false);
  };

  const disarmReset = () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    setResetArmed(false);
  };

  const switchQuestion = (i: number) => {
    disarmDel();
    clearFlag();
    setActiveIdx(i);
  };

  const handleAddQuestion = () => {
    if (atMax) {
      actions.toast('Question limit reached', 'warn');
      return;
    }
    disarmDel();
    clearFlag();
    const nextType = activeQuestion?.type ?? 'predicate';
    const nextIdx = draft.questions.length;
    actions.addDecisionQuestion(nextType);
    setActiveIdx(nextIdx);
    if (mode !== 'build') setMode('build');
    requestAnimationFrame(() => promptRef.current?.focus());
  };

  const handleDeleteQuestion = () => {
    if (draft.questions.length <= 1) return;
    if (!delArmed) {
      setDelArmed(true);
      actions.toast(`Press again to delete question ${safeIdx + 1}`, 'info');
      if (delTimerRef.current) clearTimeout(delTimerRef.current);
      delTimerRef.current = setTimeout(() => setDelArmed(false), 2200);
      return;
    }
    disarmDel();
    clearFlag();
    const nextLen = draft.questions.length - 1;
    actions.removeDecisionQuestion(safeIdx);
    setActiveIdx(Math.min(safeIdx, Math.max(0, nextLen - 1)));
    actions.toast('Question deleted', 'info');
  };

  const handleSetType = (next: DecisionQuestionType) => {
    if (!activeQuestion || activeQuestion.type === next) return;
    clearFlag();
    let note = '';
    if (
      next === 'score' &&
      !activeQuestion.levels?.length &&
      (activeQuestion.choices?.length ?? 0) > MAX_DECISION_LEVELS
    ) {
      note = ` · kept first ${MAX_DECISION_LEVELS}`;
    }
    actions.setDecisionQuestionType(safeIdx, next);
    actions.toast(`Type: ${TYPE_NAME[next]}${note}`, 'info');
  };

  const handleReset = () => {
    if (!resetArmed) {
      setResetArmed(true);
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => setResetArmed(false), 2200);
      return;
    }
    disarmReset();
    clearFlag();
    const hadRun = !!run;
    actions.resetDecisionDraft();
    setActiveIdx(0);
    actions.toast(hadRun ? 'Restored last run' : 'Draft cleared', 'info');
  };

  const handleRun = async () => {
    if (running) return;
    const first = problemDetails[0];
    if (first) {
      setMode('build');
      if (first.questionIndex !== undefined) {
        setActiveIdx(first.questionIndex);
      }
      const nonce = Date.now();
      setFlag({
        field: first.field,
        questionIndex: first.questionIndex,
        message: first.message,
        nonce,
        shaking: true,
      });
      if (flagTimerRef.current) clearTimeout(flagTimerRef.current);
      flagTimerRef.current = setTimeout(() => setFlag(null), 1800);
      actions.toast(first.message, 'warn');
      requestAnimationFrame(() => {
        if (first.field === 'input') inputRef.current?.focus();
        else if (first.field === 'name') keyRef.current?.focus();
        else if (first.field === 'prompt') promptRef.current?.focus();
      });
      return;
    }
    clearFlag();
    const ok = await actions.runDecision();
    if (ok) setMode('results');
  };

  const questionRail = (isTop: boolean) => (
    <div className={`dec-qrail${isTop ? ' is-top' : ''}`}>
      <span className="dec-qrail-label">QUESTIONS</span>
      <div className="dec-qchips" ref={chipsRef}>
        {draft.questions.map((q, i) => {
          const hasErr = flag !== null && flag.questionIndex === i;
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: questions are addressed by position while names are edited
              key={i}
              type="button"
              className={`dec-qchip${i === safeIdx ? ' is-active' : ''}${hasErr ? ' has-err' : ''}`}
              title={`Question ${i + 1}: ${q.name || 'unnamed'} · ${TYPE_NAME[q.type]}`}
              aria-pressed={i === safeIdx}
              onClick={() => switchQuestion(i)}
            >
              <b>{String(i + 1).padStart(2, '0')}</b>
              <i>{TYPE_TAG[q.type]}</i>
            </button>
          );
        })}
      </div>
      <div className="dec-qrail-actions">
        <button
          type="button"
          className="dec-qstep add"
          disabled={atMax}
          title={
            atMax
              ? `At most ${MAX_DECISION_QUESTIONS} questions`
              : 'Add question'
          }
          aria-label="Add question"
          onClick={handleAddQuestion}
        >
          <I n="plus" s={14} w={2.6} />
        </button>
        <button
          type="button"
          className={`dec-qstep del${delArmed ? ' armed' : ''}`}
          disabled={draft.questions.length <= 1}
          title={
            delArmed
              ? `Press again to delete question ${safeIdx + 1}`
              : 'Delete current question'
          }
          aria-label="Delete current question"
          onClick={handleDeleteQuestion}
        >
          <I n="x" s={12} w={2.6} />
        </button>
      </div>
    </div>
  );

  /* footer status readout for BUILD */
  const buildStatus = (() => {
    if (running)
      return { cls: 'dec-status ok', text: 'EVALUATING WITH MODEL…' };
    if (flag) return { cls: 'dec-status err', text: flag.message };
    if (problemDetails[0]) {
      const more =
        problemDetails.length > 1 ? ` (+${problemDetails.length - 1})` : '';
      return {
        cls: 'dec-status',
        text: `TO RUN: ${problemDetails[0].message}${more}`,
      };
    }
    if (stale)
      return {
        cls: 'dec-status warn',
        text: 'STALE · EDITED SINCE LAST RUN',
      };
    return {
      cls: 'dec-status ok',
      text: `Q${safeIdx + 1} OF ${draft.questions.length} · READY TO RUN`,
    };
  })();

  const canReset = run
    ? stale
    : !!(
        draft.input.trim() ||
        draft.title.trim() ||
        draft.questions.length > 1 ||
        draft.questions[0]?.instructions.trim()
      );

  return (
    <main
      className="dec-stage scroll-thin"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void handleRun();
        }
      }}
    >
      <div className="dec-card">
        {/* ── header ── */}
        <header className="dec-head">
          <div className="dec-brand">
            <Link
              to="/decisions"
              className="dec-qstep"
              aria-label="Back to decisions"
              title="Back to decisions"
            >
              <I n="arrow-left" s={13} w={2.4} />
            </Link>
            <span className="dec-mark" />
            <input
              value={draft.title}
              maxLength={MAX_DECISION_TITLE}
              aria-label="Decision title"
              placeholder="Untitled decision"
              onChange={(e) => actions.setDecisionTitle(e.target.value)}
              className="dec-title-input"
            />
          </div>
          <div className="dec-head-actions">
            <div className="dec-seg">
              <button
                type="button"
                className={`dec-seg-btn${mode === 'build' ? ' is-active' : ''}`}
                aria-pressed={mode === 'build'}
                onClick={() => setMode('build')}
              >
                BUILD
              </button>
              <button
                type="button"
                className={`dec-seg-btn${mode === 'results' ? ' is-active' : ''}`}
                aria-pressed={mode === 'results'}
                onClick={() => setMode('results')}
              >
                RESULTS{answers.length > 0 ? ` · ${answers.length}` : ''}
              </button>
            </div>
            <DeleteButton id={draft.id} title={draft.title} stored={!!run} />
          </div>
        </header>

        {/* ── meta strip ── */}
        <div className="dec-meta">
          <div className="dec-meta-stats">
            {run ? (
              <>
                <span>
                  {run.kind === 'systemone' ? 'SYSTEM ONE' : 'DECISIONS'}
                </span>
                {run.usage && (
                  <span>
                    &middot; {kfmt(run.usage.promptTokens)} IN /{' '}
                    {kfmt(run.usage.completionTokens)} OUT
                  </span>
                )}
                {run.usage?.costUsd !== undefined && (
                  <span>&middot; {$fmt(run.usage.costUsd)}</span>
                )}
                {run.latencyMs !== undefined && (
                  <span>&middot; {run.latencyMs} MS</span>
                )}
                <span className="truncate">
                  &middot; {modelName(models, run.modelId).toUpperCase()}
                </span>
                <span title={fullTimestamp(run.updatedAt)}>
                  &middot; {timeAgo(run.updatedAt).toUpperCase()}
                </span>
              </>
            ) : (
              <span>
                PREDICATE &middot; CHOICE &middot; SCORE &middot; AUTOSAVED
                DRAFT
              </span>
            )}
          </div>
          <span>REF D-{draft.id.slice(0, 6).toUpperCase()}</span>
        </div>

        {/* ── error banner ── */}
        {runError && (
          <div className="dec-error-banner" role="alert" aria-live="assertive">
            <I n="alert" s={14} w={2.2} />
            <div>
              <div className="dec-error-title">DECISION FAILED</div>
              <div className="dec-error-body">{runError}</div>
            </div>
          </div>
        )}

        {/* ── BUILD VIEW ── */}
        {mode === 'build' && (
          <section aria-label="Build decision">
            <div className="dec-sec">
              <div className="dec-sec-head">
                <span className="dec-sec-label">
                  <b>01</b> / MODEL
                </span>
                <span className="dec-hint">
                  SYSTEM ONE &middot; DECISIONS &middot; CHAT
                </span>
              </div>
              <DecisionModelPicker
                invalid={flag?.field === 'model'}
                shakeKey={flag?.field === 'model' ? flag.nonce : 0}
              />
            </div>

            <div className="dec-sec">
              <div className="dec-sec-head">
                <span className="dec-sec-label">
                  <b>02</b> / INPUT TEXT
                </span>
                <span
                  className={`dec-count${draft.input.length > MAX_DECISION_INPUT * 0.9 ? ' warn' : ''}`}
                >
                  {draft.input.length.toLocaleString()}/
                  {kfmt(MAX_DECISION_INPUT)}
                </span>
              </div>
              <AutoTextarea
                textareaRef={inputRef}
                value={draft.input}
                growKey={mode}
                maxPx={240}
                maxLength={MAX_DECISION_INPUT}
                aria-label="Input to evaluate"
                placeholder="Paste or type the text every question is evaluated against…"
                onChange={(e) => {
                  if (flag?.field === 'input') clearFlag();
                  actions.setDecisionInput(e.target.value);
                }}
                onAnimationEnd={() =>
                  setFlag((f) => (f ? { ...f, shaking: false } : null))
                }
                className={`dec-input-area scroll-thin${flag?.field === 'input' ? ' err' : ''}${flag?.field === 'input' && flag.shaking ? ' shake' : ''}`}
              />
            </div>

            {questionRail(false)}

            {activeQuestion ? (
              <ActiveQuestionEditor
                q={activeQuestion}
                index={safeIdx}
                answer={stale ? undefined : activeAnswer}
                flag={flag?.questionIndex === safeIdx ? flag : null}
                onClearFlag={clearFlag}
                onStopShake={() =>
                  setFlag((f) => (f ? { ...f, shaking: false } : null))
                }
                onSetType={handleSetType}
                keyRef={keyRef}
                promptRef={promptRef}
              />
            ) : (
              <div className="dec-sec py-6 text-center">
                <button
                  type="button"
                  className="dec-add"
                  onClick={handleAddQuestion}
                >
                  <I n="plus" s={12} w={2.6} />
                  <span>ADD QUESTION</span>
                </button>
              </div>
            )}

            <footer className="dec-foot">
              <span className={buildStatus.cls} aria-live="polite">
                {buildStatus.text}
              </span>
              <div className="dec-foot-btns">
                <button
                  type="button"
                  className={`dec-btn ghost${resetArmed ? ' armed' : ''}`}
                  disabled={running || !canReset}
                  onClick={handleReset}
                >
                  {resetArmed ? 'SURE?' : run ? 'REVERT' : 'RESET'}
                </button>
                <Tip label="Run · ⌘↵" side="top">
                  <button
                    type="button"
                    className="dec-btn solid"
                    disabled={running}
                    onClick={() => void handleRun()}
                  >
                    {running ? (
                      <span className="block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    ) : (
                      <I n="play" s={11} w={2.4} />
                    )}
                    <span>
                      {running
                        ? 'RUNNING…'
                        : answers.length > 0
                          ? 'RUN AGAIN'
                          : 'RUN DECISION'}
                    </span>
                  </button>
                </Tip>
              </div>
            </footer>
          </section>
        )}

        {/* ── RESULTS VIEW ── */}
        {mode === 'results' && (
          <section aria-label="Decision results">
            {results.length > 0 && (
              <div className={`dec-sec${stale ? ' opacity-70' : ''}`}>
                <div className="dec-sec-head">
                  <span className="dec-sec-label">
                    <b>01</b> / SUMMARY
                    <span className="dec-cnum">
                      {results.length}/{draft.questions.length}
                    </span>
                  </span>
                  {stale ? (
                    <span className="dec-status warn">
                      STALE &middot; FROM BEFORE YOUR EDITS
                    </span>
                  ) : (
                    <span className="dec-hint">CLICK A ROW TO INSPECT</span>
                  )}
                </div>
                <div>
                  {draft.questions.map((q, i) => {
                    const a = answers.find((x) => x.name === q.name);
                    if (!a) return null;
                    const bar = answerBar(a);
                    return (
                      <button
                        // biome-ignore lint/suspicious/noArrayIndexKey: matches question rail positions
                        key={i}
                        type="button"
                        className={`dec-sum-row${i === safeIdx ? ' is-active' : ''}`}
                        onClick={() => switchQuestion(i)}
                      >
                        <span className="dec-badge">
                          {String(i + 1).padStart(2, '0')}
                        </span>
                        <span className="w-[108px] shrink-0 truncate font-mono text-[11px] font-semibold text-[var(--dec-muted)]">
                          {a.name}
                        </span>
                        <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-bold">
                          {a.type === 'refusal' ? 'Refused' : headline(a, q)}
                        </span>
                        {bar !== null && (
                          <span className="hidden w-[76px] shrink-0 sm:block">
                            <BrutalistBar
                              v={bar}
                              label={`${a.name} ${a.type === 'predicate' ? 'probability' : 'confidence'}`}
                            />
                          </span>
                        )}
                        {a.confidence !== undefined && (
                          <span className="dec-count w-[36px] shrink-0 text-right">
                            {pct(a.confidence)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {questionRail(results.length === 0)}

            {activeQuestion && (
              <QuestionResultView
                q={activeQuestion}
                index={safeIdx}
                total={draft.questions.length}
                answer={activeAnswer}
                stale={stale}
              />
            )}

            {orphans.length > 0 && (
              <div className="dec-sec opacity-70">
                <div className="dec-sec-head">
                  <span className="dec-sec-label">
                    ORPHANED ANSWERS
                    <span className="dec-cnum">{orphans.length}</span>
                  </span>
                  <span className="dec-hint">
                    FROM QUESTIONS RENAMED OR REMOVED
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {orphans.map((a) => (
                    <OrphanAnswerRow key={a.name} a={a} />
                  ))}
                </div>
              </div>
            )}

            <footer className="dec-foot">
              <span
                className={
                  running
                    ? 'dec-status ok'
                    : stale
                      ? 'dec-status warn'
                      : answers.length > 0
                        ? 'dec-status ok'
                        : 'dec-status'
                }
                aria-live="polite"
              >
                {running
                  ? 'EVALUATING WITH MODEL…'
                  : stale
                    ? 'STALE · RE-RUN TO REFRESH ANSWERS'
                    : answers.length > 0
                      ? `EVALUATED · ${results.length} ${results.length === 1 ? 'ANSWER' : 'ANSWERS'}`
                      : 'NOT EVALUATED YET · PRESS RUN DECISION'}
              </span>
              <div className="dec-foot-btns">
                <button
                  type="button"
                  className="dec-btn ghost"
                  onClick={() => setMode('build')}
                >
                  EDIT IN BUILD
                </button>
                <Tip label="Run · ⌘↵" side="top">
                  <button
                    type="button"
                    className="dec-btn solid"
                    disabled={running}
                    onClick={() => void handleRun()}
                  >
                    {running ? (
                      <span className="block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    ) : (
                      <I n="play" s={11} w={2.4} />
                    )}
                    <span>
                      {running
                        ? 'RUNNING…'
                        : answers.length > 0
                          ? 'RUN AGAIN'
                          : 'RUN DECISION'}
                    </span>
                  </button>
                </Tip>
              </div>
            </footer>
          </section>
        )}
      </div>
    </main>
  );
}

/* ── active question editor (BUILD) ───────────────────────────────── */

function ActiveQuestionEditor({
  q,
  index,
  answer,
  flag,
  onClearFlag,
  onStopShake,
  onSetType,
  keyRef,
  promptRef,
}: {
  q: DecisionQuestion;
  index: number;
  answer: DecisionAnswer | undefined;
  flag: FlagState | null;
  onClearFlag: () => void;
  onStopShake: () => void;
  onSetType: (t: DecisionQuestionType) => void;
  keyRef: React.RefObject<HTMLInputElement | null>;
  promptRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const update = (
    patch: Parameters<typeof actions.updateDecisionQuestion>[1],
  ) => actions.updateDecisionQuestion(index, patch);

  const choices = q.choices ?? [];
  const levels = q.levels ?? [];
  const growSeed = `${index}:${q.type}:${choices.length}:${levels.length}`;

  const nameInvalid =
    flag?.field === 'name' || (q.name !== '' && !DECISION_NAME_RE.test(q.name));
  const promptInvalid = flag?.field === 'prompt';
  const choicesFlagged = flag?.field === 'choices';
  const levelsFlagged = flag?.field === 'levels';

  /* detect duplicate choice values so we can flag offending rows */
  const choiceCounts = new Map<string, number>();
  for (const c of choices) {
    const v = c.value.trim();
    if (v) choiceCounts.set(v, (choiceCounts.get(v) ?? 0) + 1);
  }

  return (
    <>
      <div className="dec-sec dec-sec-q">
        <div className="dec-sec-head">
          <span className="dec-sec-label">
            <b>03</b> / QUESTION PROMPT
          </span>
          <div className="dec-head-right">
            <label
              onAnimationEnd={onStopShake}
              className={`dec-key-wrap${nameInvalid ? ' err' : ''}${flag?.field === 'name' && flag.shaking ? ' shake' : ''}`}
              title="Identifier key for this question's answer (letters, digits, _ or -)"
            >
              <span className="dec-key-tag">KEY</span>
              <input
                ref={keyRef}
                value={q.name}
                maxLength={64}
                spellCheck={false}
                placeholder="question_key"
                aria-label="Question name"
                onChange={(e) => {
                  if (flag?.field === 'name') onClearFlag();
                  actions.renameDecisionQuestion(index, e.target.value);
                }}
                className="dec-key-input"
              />
            </label>
            <span
              className={`dec-count${q.instructions.length > MAX_DECISION_INSTRUCTIONS * 0.9 ? ' warn' : ''}`}
            >
              {q.instructions.length}/{MAX_DECISION_INSTRUCTIONS}
            </span>
          </div>
        </div>
        <AutoTextarea
          textareaRef={promptRef}
          value={q.instructions}
          growKey={growSeed}
          maxLength={MAX_DECISION_INSTRUCTIONS}
          aria-label={`Instructions for ${q.name || `question ${index + 1}`}`}
          placeholder="Type the question for the model…"
          onChange={(e) => {
            if (promptInvalid) onClearFlag();
            update({ instructions: e.target.value });
          }}
          onAnimationEnd={onStopShake}
          className={`dec-q-textarea${promptInvalid ? ' err' : ''}${promptInvalid && flag?.shaking ? ' shake' : ''}`}
        />
      </div>

      <div className="dec-sec">
        <div className="dec-sec-head">
          <span className="dec-sec-label">
            <b>04</b> /{' '}
            {q.type === 'score'
              ? 'LEVELS'
              : q.type === 'choice'
                ? 'CHOICES'
                : 'CRITERIA'}
            <span className="dec-cnum">
              {q.type === 'predicate'
                ? 'TRUE/FALSE'
                : q.type === 'choice'
                  ? `${choices.length}/${MAX_DECISION_CHOICES}`
                  : `${levels.length}/${MAX_DECISION_LEVELS}`}
            </span>
          </span>
          <div className="dec-head-right">
            <span className="dec-hint">{TYPE_HINT[q.type]}</span>
            <fieldset
              className="dec-typeseg"
              aria-label={`Question type for ${q.name || 'this question'}`}
            >
              {TYPE_ORDER.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={q.type === t ? 'is-active' : ''}
                  aria-pressed={q.type === t}
                  onClick={() => onSetType(t)}
                >
                  {TYPE_NAME[t]}
                </button>
              ))}
            </fieldset>
          </div>
        </div>

        {/* PREDICATE (TRUE / FALSE criteria) */}
        {q.type === 'predicate' && (
          <div>
            {(['true', 'false'] as const).map((k) => {
              const prob =
                answer?.type === 'predicate' ? answer.probability : undefined;
              const picked =
                prob !== undefined && (k === 'true' ? prob >= 0.5 : prob < 0.5);
              return (
                <div
                  key={k}
                  className={`dec-choice is-noul${picked ? ' is-correct' : ''}`}
                >
                  <span className="dec-badge">{k === 'true' ? 'T' : 'F'}</span>
                  <div className="dec-fields">
                    <span className="dec-fixed-label">{k.toUpperCase()}</span>
                    <AutoTextarea
                      value={q.criteria?.[k] ?? ''}
                      growKey={growSeed}
                      maxLength={MAX_DECISION_CRITERION}
                      spellCheck={false}
                      aria-label={`What counts as ${k}`}
                      placeholder={`Criteria for ${k.toUpperCase()} (optional, read by Typesafe-backed models)…`}
                      onChange={(e) =>
                        update({
                          criteria: { ...q.criteria, [k]: e.target.value },
                        })
                      }
                      className="dec-choice-desc"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* CHOICE */}
        {q.type === 'choice' && (
          <>
            <div>
              {choices.map((c, i) => {
                const trimmed = c.value.trim();
                const isDup =
                  trimmed !== '' && (choiceCounts.get(trimmed) ?? 0) > 1;
                const rowErr = choicesFlagged && (trimmed === '' || isDup);
                const picked =
                  answer?.type === 'choice' &&
                  trimmed !== '' &&
                  answer.choice === c.value;
                return (
                  <OptionRow
                    // biome-ignore lint/suspicious/noArrayIndexKey: keyed by position so typing doesn't remount inputs
                    key={i}
                    badge={choiceBadge(i)}
                    value={c.value}
                    description={c.description ?? ''}
                    valuePlaceholder="Choice value…"
                    descPlaceholder="When does this choice apply? (optional)"
                    noun="choice"
                    index={i}
                    growSeed={growSeed}
                    highlighted={picked}
                    invalid={rowErr}
                    shaking={rowErr && !!flag?.shaking}
                    canUp={i > 0}
                    canDown={i < choices.length - 1}
                    canRemove={choices.length > MIN_DECISION_CHOICES}
                    onStopShake={onStopShake}
                    onValue={(value) => {
                      if (choicesFlagged) onClearFlag();
                      update({
                        choices: choices.map((x, j) =>
                          j === i ? { ...x, value } : x,
                        ),
                      });
                    }}
                    onDesc={(description) =>
                      update({
                        choices: choices.map((x, j) =>
                          j === i ? { ...x, description } : x,
                        ),
                      })
                    }
                    onMove={(dir) =>
                      actions.moveDecisionQuestionEntry(index, i, dir)
                    }
                    onRemove={() =>
                      update({ choices: choices.filter((_, j) => j !== i) })
                    }
                  />
                );
              })}
            </div>
            <button
              type="button"
              className="dec-add"
              disabled={choices.length >= MAX_DECISION_CHOICES}
              onClick={() => update({ choices: [...choices, { value: '' }] })}
            >
              <I n="plus" s={12} w={2.6} />
              <span>ADD CHOICE</span>
            </button>
          </>
        )}

        {/* SCORE */}
        {q.type === 'score' && (
          <>
            <div>
              {levels.map((l, i) => {
                const rowErr = levelsFlagged && l.label.trim() === '';
                const nearest =
                  answer?.type === 'score' &&
                  answer.score !== undefined &&
                  Math.round(answer.score) === i;
                return (
                  <OptionRow
                    // biome-ignore lint/suspicious/noArrayIndexKey: keyed by position so typing doesn't remount inputs
                    key={i}
                    badge={String(i)}
                    value={l.label}
                    description={l.description ?? ''}
                    valuePlaceholder="Level label (lowest first)…"
                    descPlaceholder="What belongs at this level? (optional)"
                    noun="level"
                    index={i}
                    growSeed={growSeed}
                    highlighted={nearest}
                    invalid={rowErr}
                    shaking={rowErr && !!flag?.shaking}
                    canUp={i > 0}
                    canDown={i < levels.length - 1}
                    canRemove={levels.length > MIN_DECISION_LEVELS}
                    onStopShake={onStopShake}
                    onValue={(label) => {
                      if (levelsFlagged) onClearFlag();
                      update({
                        levels: levels.map((x, j) =>
                          j === i ? { ...x, label } : x,
                        ),
                      });
                    }}
                    onDesc={(description) =>
                      update({
                        levels: levels.map((x, j) =>
                          j === i ? { ...x, description } : x,
                        ),
                      })
                    }
                    onMove={(dir) =>
                      actions.moveDecisionQuestionEntry(index, i, dir)
                    }
                    onRemove={() =>
                      update({ levels: levels.filter((_, j) => j !== i) })
                    }
                  />
                );
              })}
            </div>
            <button
              type="button"
              className="dec-add"
              disabled={levels.length >= MAX_DECISION_LEVELS}
              onClick={() => update({ levels: [...levels, { label: '' }] })}
            >
              <I n="plus" s={12} w={2.6} />
              <span>ADD LEVEL</span>
            </button>
          </>
        )}
      </div>
    </>
  );
}

function OptionRow({
  badge,
  value,
  description,
  valuePlaceholder,
  descPlaceholder,
  noun,
  index,
  growSeed,
  highlighted,
  invalid,
  shaking,
  canUp,
  canDown,
  canRemove,
  onStopShake,
  onValue,
  onDesc,
  onMove,
  onRemove,
}: {
  badge: string;
  value: string;
  description: string;
  valuePlaceholder: string;
  descPlaceholder: string;
  noun: string;
  index: number;
  growSeed: string;
  highlighted: boolean;
  invalid: boolean;
  shaking: boolean;
  canUp: boolean;
  canDown: boolean;
  canRemove: boolean;
  onStopShake: () => void;
  onValue: (v: string) => void;
  onDesc: (v: string) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const descRef = useRef<HTMLTextAreaElement | null>(null);

  return (
    <div
      onAnimationEnd={onStopShake}
      className={`dec-choice${highlighted ? ' is-correct' : ''}${invalid ? ' err' : ''}${shaking ? ' shake' : ''}`}
    >
      <span className="dec-badge">{badge}</span>
      <div className="dec-fields">
        <input
          value={value}
          maxLength={MAX_DECISION_OPTION_KEY}
          spellCheck={false}
          aria-label={`${noun} ${index + 1}`}
          placeholder={valuePlaceholder}
          onChange={(e) => onValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              descRef.current?.focus();
            }
          }}
          className={`dec-choice-text${invalid ? ' err' : ''}`}
        />
        <AutoTextarea
          textareaRef={descRef}
          value={description}
          growKey={growSeed}
          maxLength={MAX_DECISION_CRITERION}
          spellCheck={false}
          aria-label={`${noun} ${index + 1} description`}
          placeholder={descPlaceholder}
          onChange={(e) => onDesc(e.target.value)}
          className="dec-choice-desc"
        />
      </div>
      <div className="dec-row-tools">
        <button
          type="button"
          className="dec-tool"
          disabled={!canUp}
          title="Move up"
          aria-label={`Move ${noun} ${index + 1} up`}
          onClick={() => onMove(-1)}
        >
          <I n="chevron-up" s={12} w={2.6} />
        </button>
        <button
          type="button"
          className="dec-tool"
          disabled={!canDown}
          title="Move down"
          aria-label={`Move ${noun} ${index + 1} down`}
          onClick={() => onMove(1)}
        >
          <I n="chevron-down-sm" s={12} w={2.6} />
        </button>
        <button
          type="button"
          className="dec-tool del"
          disabled={!canRemove}
          title={`Remove ${noun}`}
          aria-label={`Remove ${noun} ${index + 1}`}
          onClick={onRemove}
        >
          <I n="x" s={12} w={2.6} />
        </button>
      </div>
    </div>
  );
}

/* ── question result inspection (RESULTS) ─────────────────────────── */

function QuestionResultView({
  q,
  index,
  total,
  answer,
  stale,
}: {
  q: DecisionQuestion;
  index: number;
  total: number;
  answer: DecisionAnswer | undefined;
  stale: boolean;
}) {
  const prompt = q.instructions.trim();
  const dist = answer?.probabilities ?? [];
  const labels = answer ? levelLabels(answer, q) : {};

  return (
    <div className={`dec-pv${stale ? ' opacity-70' : ''}`}>
      <div className="dec-pv-label">
        <span>
          {total > 1 ? `Q${index + 1}/${total} · ` : ''}
          {(q.name || 'UNNAMED').toUpperCase()} &middot; {TYPE_NAME[q.type]}
        </span>
        {answer ? (
          answer.type === 'refusal' ? (
            <span className="dec-pv-key is-err">REFUSED BY MODEL</span>
          ) : (
            <span className="dec-pv-key is-set">
              RESULT: {headline(answer, q)}
              {answer.confidence !== undefined
                ? ` · CONF ${pct(answer.confidence)}`
                : ''}
            </span>
          )
        ) : (
          <span className="dec-pv-key">RESULT: &mdash;</span>
        )}
      </div>

      <div className={`dec-pv-q${prompt ? '' : ' is-ghost'}`}>
        {prompt || 'Untitled question prompt'}
      </div>

      {answer?.type === 'refusal' && (
        <div className="mb-2.5 rounded-[2px] border-2 border-[var(--dec-danger)] bg-[var(--dec-danger-tint)] px-2.5 py-2 font-mono text-[11px] font-semibold text-[var(--dec-danger)]">
          THE MODEL DECLINED TO ANSWER THIS QUESTION.
        </div>
      )}

      {/* PREDICATE outcomes */}
      {q.type === 'predicate' && (
        <div>
          {(['true', 'false'] as const).map((k) => {
            const pTrue =
              answer?.type === 'predicate' ? answer.probability : undefined;
            const p =
              pTrue !== undefined
                ? k === 'true'
                  ? pTrue
                  : 1 - pTrue
                : undefined;
            const winner =
              pTrue !== undefined &&
              (k === 'true' ? pTrue >= 0.5 : pTrue < 0.5);
            const desc = q.criteria?.[k]?.trim() ?? '';
            return (
              <div key={k} className="dec-pv-item">
                <div className={`dec-pv-opt${winner ? ' right' : ''}`}>
                  <span className="dec-badge">{k === 'true' ? 'T' : 'F'}</span>
                  <span className="dec-pv-t">{k.toUpperCase()}</span>
                  {p !== undefined && (
                    <span className="dec-pv-stat">
                      <span className="w-[84px] sm:w-[120px]">
                        <BrutalistBar v={p} label={`${k} probability`} />
                      </span>
                      <span className="dec-pv-pct">{pct(p)}</span>
                    </span>
                  )}
                  <span className="dec-pv-mark">
                    {winner && <I n="check" s={13} w={2.6} />}
                  </span>
                </div>
                {desc && (
                  <div className={`dec-pv-desc${winner ? ' key' : ''}`}>
                    {desc}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* CHOICE outcomes */}
      {q.type === 'choice' && (
        <div>
          {(q.choices ?? []).map((c, i) => {
            const has = c.value.trim() !== '';
            const prob = dist.find(
              (p) => has && String(p.value) === c.value,
            )?.probability;
            const winner =
              answer?.type === 'choice' && has && answer.choice === c.value;
            const desc = c.description?.trim() ?? '';
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: matches static option positions
              <div key={i} className="dec-pv-item">
                <div className={`dec-pv-opt${winner ? ' right' : ''}`}>
                  <span className="dec-badge">{choiceBadge(i)}</span>
                  <span className={`dec-pv-t${has ? '' : ' is-ghost'}`}>
                    {has ? c.value : `Choice ${choiceBadge(i)}`}
                  </span>
                  {prob !== undefined && (
                    <span className="dec-pv-stat">
                      <span className="w-[84px] sm:w-[120px]">
                        <BrutalistBar
                          v={prob}
                          label={`${c.value} probability`}
                        />
                      </span>
                      <span className="dec-pv-pct">{pct(prob)}</span>
                    </span>
                  )}
                  <span className="dec-pv-mark">
                    {winner && <I n="check" s={13} w={2.6} />}
                  </span>
                </div>
                {desc && (
                  <div className={`dec-pv-desc${winner ? ' key' : ''}`}>
                    {desc}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* SCORE outcomes */}
      {q.type === 'score' && (
        <div>
          {answer?.type === 'score' && answer.score !== undefined && (
            <div className="mb-2 flex items-center gap-2.5 rounded-[2px] border border-[var(--dec-hair)] px-2.5 py-1.5 font-mono text-[10.5px]">
              <span className="font-bold text-[var(--dec-muted)]">
                WEIGHTED SCORE
              </span>
              <span className="font-bold text-[var(--dec-accent)]">
                {answer.score.toFixed(2)} /{' '}
                {Math.max(1, (q.levels?.length ?? 2) - 1)}
              </span>
              <span className="flex-1">
                <BrutalistBar
                  v={answer.score / Math.max(1, (q.levels?.length ?? 2) - 1)}
                  label={`${q.name} weighted score`}
                />
              </span>
            </div>
          )}
          {(q.levels ?? []).map((l, i) => {
            const has = l.label.trim() !== '';
            const prob = dist.find(
              (p) =>
                Number(p.value) === i ||
                String(p.value) === String(i) ||
                (has && p.label === l.label),
            )?.probability;
            const nearest =
              answer?.type === 'score' &&
              answer.score !== undefined &&
              Math.round(answer.score) === i;
            const desc = l.description?.trim() ?? '';
            const displayLabel = has
              ? l.label
              : (labels[String(i)] ?? `Level ${i}`);
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: ordered level indices
              <div key={i} className="dec-pv-item">
                <div className={`dec-pv-opt${nearest ? ' right' : ''}`}>
                  <span className="dec-badge">{i}</span>
                  <span className={`dec-pv-t${has ? '' : ' is-ghost'}`}>
                    {displayLabel}
                  </span>
                  {prob !== undefined && (
                    <span className="dec-pv-stat">
                      <span className="w-[84px] sm:w-[120px]">
                        <BrutalistBar
                          v={prob}
                          label={`${displayLabel} probability`}
                        />
                      </span>
                      <span className="dec-pv-pct">{pct(prob)}</span>
                    </span>
                  )}
                  <span className="dec-pv-mark">
                    {nearest && <I n="check" s={13} w={2.6} />}
                  </span>
                </div>
                {desc && (
                  <div className={`dec-pv-desc${nearest ? ' key' : ''}`}>
                    {desc}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function OrphanAnswerRow({ a }: { a: DecisionAnswer }) {
  const bar = answerBar(a);
  return (
    <div className="flex items-center gap-2 rounded-[2px] border border-[var(--dec-stroke)] bg-[var(--dec-field)] px-2.5 py-1.5">
      <span className="min-w-0 truncate font-mono text-[11.5px] font-semibold text-[var(--dec-muted)]">
        {a.name}
      </span>
      <span className="dec-model-tag">{a.type.toUpperCase()}</span>
      <span className="ml-auto truncate font-mono text-[13px] font-bold">
        {a.type === 'refusal' ? 'Refused' : headline(a, undefined)}
      </span>
      {bar !== null && (
        <span className="hidden w-[64px] shrink-0 sm:block">
          <BrutalistBar v={bar} label={`${a.name} confidence`} />
        </span>
      )}
      {a.confidence !== undefined && (
        <span className="dec-count shrink-0">{pct(a.confidence)}</span>
      )}
    </div>
  );
}

function BrutalistBar({ v, label }: { v: number; label: string }) {
  const pctg = Math.max(0, Math.min(1, v)) * 100;
  return (
    <span
      className="dec-bar"
      role="progressbar"
      aria-valuenow={Math.round(pctg)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <span style={{ width: `${pctg}%` }} />
    </span>
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
        className="dec-qstep del"
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
        <I n="trash" s={13} w={2.1} />
      </button>
    </Tip>
  );
}

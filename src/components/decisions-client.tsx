/*
 * DecisionsClient / DecisionEditor — the /decisions run list and one run's
 * neo-brutalist editor (BUILD / RESULTS) with Single and Batch evaluation
 * modes and a sortable/filterable Results Table UI.
 *
 * Business logic:
 * - The list is the user's stored runs, newest edit first; it refetches on
 *   mount (never cached locally). Each row previews its answers, or says the
 *   run never answered or that its last attempt failed, so the row tells you
 *   what opening it will show.
 * - Examples are the empty state: with no runs they are the page; once runs
 *   exist they fold into a "Start from an example" disclosure under the list.
 *   Each example can be opened as a single run or directly as a multi-row
 *   batch seeded with sample inputs.
 * - "New decision" and "New batch" mint a run client-side and route into its
 *   editor before anything is stored: a single draft only reaches the database
 *   when it is run, and batch rows evaluate client-side against the stateless
 *   `POST /api/decisions` (`stateless: true`) endpoint.
 * - In Batch mode, BUILD lets the user edit individual input rows (with
 *   optional row labels/IDs), reorder/duplicate/remove rows, or bulk-import
 *   via paste or file upload (lines, `---` blocks, CSV/TSV with header
 *   detection, or JSON/JSONL).
 * - RESULTS renders a neo-brutalist Table UI (rows = inputs, columns =
 *   questions + status/latency) with live progress as rows complete, per-row
 *   retry and Retry Failed, column sorting, text/status/outcome filtering,
 *   per-question aggregate statistics (predicate pass rate, choice breakdown,
 *   average score), CSV/JSON/TSV export, and a row + question probability
 *   distribution inspector below the table.
 */
'use client';

import {
  type ChangeEvent,
  type TextareaHTMLAttributes,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useParams_UNSTABLE } from 'waku/router/client';
import {
  answerBar,
  answerValue,
  type BatchImportMode,
  DECISION_EXAMPLES,
  DECISION_NAME_RE,
  type DecisionBatchItem,
  type DecisionDraft,
  type DecisionProblemField,
  decisionProblemDetails,
  formatBatchCsv,
  formatBatchJson,
  formatBatchTsv,
  levelLabels,
  MAX_DECISION_BATCH_ITEMS,
  MAX_DECISION_BATCH_LABEL,
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
  parseBatchImport,
  pct,
  summarizeBatchQuestion,
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

const downloadFile = (filename: string, content: string, mime: string) => {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

const slugifyTitle = (title: string): string =>
  (title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') ||
    'decisions');

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
      <div className="dec-stack">
        <div className="dec-card">
          <header className="dec-head">
            <div className="dec-brand">
              <span className="dec-mark" />
              <h1>DECISIONS</h1>
            </div>
            <div className="dec-head-actions">
              <button
                type="button"
                className="dec-btn ghost"
                onClick={() => actions.newBatchDecision()}
              >
                <I n="table" s={12} w={2.2} />
                <span>NEW BATCH</span>
              </button>
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
              PREDICATE &middot; CHOICE &middot; SCORE &middot; SINGLE &amp;
              BATCH EVALUATION
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

          {empty && settled && (
            <div className="dec-sec py-5 text-center">
              <p className="text-[12px] text-[var(--dec-muted)]">
                No stored runs yet — start a single or batch evaluation above,
                or pick a template below.
              </p>
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
        </div>

        {empty && settled ? (
          <section className="dec-card" aria-label="Examples">
            <div className="dec-sec">
              <div className="dec-sec-head">
                <span className="dec-sec-label">
                  <b>EX</b> / START FROM AN EXAMPLE
                  <span className="dec-cnum">{DECISION_EXAMPLES.length}</span>
                </span>
                <span className="dec-hint">SINGLE OR BATCH SAMPLE SET</span>
              </div>
              <p className="mb-2.5 text-[12px] text-[var(--dec-muted)]">
                Evaluate text against typed questions — a probability, one of
                your choices, or a score across ordered levels — on a single
                input or a multi-row batch.
              </p>
              <ExampleList />
            </div>
          </section>
        ) : (
          !empty && (
            <section className="dec-card" aria-label="Examples">
              <div className="dec-sec">
                <details className="dec-details">
                  <summary className="dec-sec-label">
                    <I n="chevron-right" s={12} w={2.4} className="dec-chev" />
                    <span>
                      <b>EX</b> / START FROM AN EXAMPLE
                    </span>
                    <span className="dec-cnum">{DECISION_EXAMPLES.length}</span>
                    <span className="dec-hint ml-auto">TEMPLATES</span>
                  </summary>
                  <div className="mt-2.5">
                    <ExampleList />
                  </div>
                </details>
              </div>
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
        <div key={e.title} className="dec-example-card">
          <button
            type="button"
            className="dec-example-main"
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
          <div className="dec-example-foot">
            <button
              type="button"
              className="dec-example-act"
              onClick={() => actions.newDecisionFromExample(e)}
            >
              SINGLE
            </button>
            <button
              type="button"
              className="dec-example-act is-batch"
              onClick={() => actions.newBatchDecisionFromExample(e)}
            >
              <I n="table" s={10} w={2.2} />
              <span>BATCH SAMPLE</span>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ── editor (/decisions/[slug]) ───────────────────────────────────── */

type FlagState = {
  field: DecisionProblemField;
  questionIndex?: number | undefined;
  batchIndex?: number | undefined;
  message: string;
  nonce: number;
  shaking: boolean;
};

type BatchSortCol = 'row' | 'input' | 'latency' | `q:${string}`;
type BatchStatusFilter = 'all' | 'done' | 'error' | 'refused';

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
  const [selectedRowIdx, setSelectedRowIdx] = useState(0);
  const [delArmed, setDelArmed] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const [flag, setFlag] = useState<FlagState | null>(null);

  /* batch import drawer state */
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importFmt, setImportFmt] = useState<BatchImportMode>('auto');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /* batch table sort & filter state */
  const [tableQuery, setTableQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<BatchStatusFilter>('all');
  const [outcomeFilter, setOutcomeFilter] = useState<{
    questionName: string;
    value: string;
  } | null>(null);
  const [sortCol, setSortCol] = useState<BatchSortCol>('row');
  const [sortAsc, setSortAsc] = useState(true);

  const seededIdRef = useRef<string>('');
  const chipsRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const batchInputRefs = useRef<Record<number, HTMLTextAreaElement | null>>({});
  const keyRef = useRef<HTMLInputElement | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const delTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flagTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    actions.setContext('new');
    setActiveIdx(0);
    setSelectedRowIdx(0);
    setDelArmed(false);
    setResetArmed(false);
    setFlag(null);
    setImportOpen(false);
    setOutcomeFilter(null);
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
    if (draft.batchMode) {
      const hasDone = (draft.batchItems ?? []).some(
        (it) => it.status === 'done',
      );
      setMode(hasDone ? 'results' : 'build');
      return;
    }
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
  const batchItems = draft?.batchItems ?? [];

  /* keep the active question chip scrolled into view */
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-center when question count or tab changes too
  useEffect(() => {
    const wrap = chipsRef.current;
    const chip = wrap?.children[safeIdx] as HTMLElement | undefined;
    if (wrap && chip) {
      wrap.scrollLeft = Math.max(0, chip.offsetLeft - 24);
    }
  }, [safeIdx, qLen, mode]);

  const parsedImportPreview = useMemo(
    () => parseBatchImport(importText, importFmt),
    [importText, importFmt],
  );

  /* batch aggregate telemetry across completed rows */
  const batchTelemetry = useMemo(() => {
    let promptTokens = 0;
    let completionTokens = 0;
    let costUsd = 0;
    let hasCost = false;
    let latencySum = 0;
    let latencyCount = 0;
    for (const it of batchItems) {
      if (it.usage) {
        promptTokens += it.usage.promptTokens;
        completionTokens += it.usage.completionTokens;
        if (it.usage.costUsd !== undefined) {
          costUsd += it.usage.costUsd;
          hasCost = true;
        }
      }
      if (it.latencyMs !== undefined) {
        latencySum += it.latencyMs;
        latencyCount++;
      }
    }
    return {
      promptTokens,
      completionTokens,
      hasTokens: promptTokens > 0 || completionTokens > 0,
      costUsd: hasCost ? costUsd : undefined,
      avgLatencyMs:
        latencyCount > 0 ? Math.round(latencySum / latencyCount) : undefined,
    };
  }, [batchItems]);

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

  const isBatch = Boolean(draft.batchMode);
  const safeRowIdx = Math.max(
    0,
    Math.min(selectedRowIdx, Math.max(0, batchItems.length - 1)),
  );
  const selectedBatchItem = batchItems[safeRowIdx];

  const batchNonEmptyCount = batchItems.filter(
    (it) => it.input.trim() !== '',
  ).length;
  const batchDoneCount = batchItems.filter((it) => it.status === 'done').length;
  const batchErrorCount = batchItems.filter(
    (it) => it.status === 'error',
  ).length;
  const batchRunningCount = batchItems.filter(
    (it) => it.status === 'running' || it.status === 'queued',
  ).length;

  const problemDetails = decisionProblemDetails(draft);
  const answers = run?.answers ?? [];
  const results = answers.filter((a) =>
    draft.questions.some((q) => q.name === a.name),
  );
  const stale = !isBatch && answers.length > 0 && !!run && drifted(draft, run);
  const orphans = answers.filter(
    (a) => !draft.questions.some((q) => q.name === a.name),
  );
  const atMax = draft.questions.length >= MAX_DECISION_QUESTIONS;
  const atMaxBatch = batchItems.length >= MAX_DECISION_BATCH_ITEMS;
  const activeQuestion = draft.questions[safeIdx];
  const activeAnswer = activeQuestion
    ? isBatch
      ? selectedBatchItem?.answers?.find((a) => a.name === activeQuestion.name)
      : answers.find((a) => a.name === activeQuestion.name)
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
    const hadRun = !!run && !isBatch;
    actions.resetDecisionDraft();
    setActiveIdx(0);
    setSelectedRowIdx(0);
    actions.toast(hadRun ? 'Restored last run' : 'Draft cleared', 'info');
  };

  const triggerValidationFlag = (first: (typeof problemDetails)[number]) => {
    setMode('build');
    if (first.questionIndex !== undefined) {
      setActiveIdx(first.questionIndex);
    }
    const nonce = Date.now();
    setFlag({
      field: first.field,
      questionIndex: first.questionIndex,
      batchIndex: first.batchIndex,
      message: first.message,
      nonce,
      shaking: true,
    });
    if (flagTimerRef.current) clearTimeout(flagTimerRef.current);
    flagTimerRef.current = setTimeout(() => setFlag(null), 1800);
    actions.toast(first.message, 'warn');
    requestAnimationFrame(() => {
      if (first.field === 'input') {
        if (isBatch) {
          const targetRow = first.batchIndex ?? 0;
          batchInputRefs.current[targetRow]?.focus();
        } else {
          inputRef.current?.focus();
        }
      } else if (first.field === 'name') keyRef.current?.focus();
      else if (first.field === 'prompt') promptRef.current?.focus();
    });
  };

  const handleRun = async () => {
    if (running) return;
    const first = problemDetails[0];
    if (first) {
      triggerValidationFlag(first);
      return;
    }
    clearFlag();
    if (isBatch) {
      /* switch to RESULTS right away so the user can watch the table populate live */
      setMode('results');
      await actions.runDecisionBatch();
      return;
    }
    const ok = await actions.runDecision();
    if (ok) setMode('results');
  };

  const handleRunSingleRow = async (rowIdx: number) => {
    if (running) return;
    const nonInputProblem = problemDetails.find((p) => p.field !== 'input');
    if (nonInputProblem) {
      triggerValidationFlag(nonInputProblem);
      return;
    }
    const item = batchItems[rowIdx];
    if (!item || !item.input.trim()) {
      triggerValidationFlag({
        field: 'input',
        batchIndex: rowIdx,
        message: `Row ${rowIdx + 1}: add input text to evaluate`,
      });
      return;
    }
    clearFlag();
    setSelectedRowIdx(rowIdx);
    await actions.runDecisionBatch({ onlyIndices: [rowIdx], concurrency: 1 });
  };

  const handleRetryFailedRows = async () => {
    if (running) return;
    const failedIndices = batchItems
      .map((it, idx) => (it.status === 'error' ? idx : -1))
      .filter((idx) => idx >= 0);
    if (failedIndices.length === 0) return;
    await actions.runDecisionBatch({ onlyIndices: failedIndices });
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const lower = file.name.toLowerCase();
      const fmt: BatchImportMode =
        lower.endsWith('.json') || lower.endsWith('.jsonl')
          ? 'json'
          : lower.endsWith('.csv') || lower.endsWith('.tsv')
            ? 'csv'
            : 'auto';
      const parsed = parseBatchImport(text, fmt);
      if (parsed.length === 0) {
        actions.toast(`No rows found in ${file.name}`, 'warn');
        return;
      }
      actions.importDecisionBatchItems(parsed, 'append');
      actions.toast(
        `Imported ${Math.min(parsed.length, MAX_DECISION_BATCH_ITEMS)} rows from ${file.name}`,
        'info',
      );
      setImportOpen(false);
    } catch {
      actions.toast(`Couldn’t read ${file.name}`, 'error');
    }
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
              <span className="dec-qchip-key">{q.name || `q_${i + 1}`}</span>
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
      return {
        cls: 'dec-status ok',
        text: isBatch
          ? `EVALUATING BATCH (${batchDoneCount + batchErrorCount}/${batchNonEmptyCount})…`
          : 'EVALUATING WITH MODEL…',
      };
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
    if (isBatch) {
      return {
        cls: 'dec-status ok',
        text: `${batchNonEmptyCount} ${batchNonEmptyCount === 1 ? 'ROW' : 'ROWS'} × ${draft.questions.length} ${draft.questions.length === 1 ? 'QUESTION' : 'QUESTIONS'} · READY TO RUN`,
      };
    }
    return {
      cls: 'dec-status ok',
      text: `Q${safeIdx + 1} OF ${draft.questions.length} · READY TO RUN`,
    };
  })();

  const canReset = isBatch
    ? batchItems.some((it) => it.input.trim() !== '' || it.status !== 'idle')
    : run
      ? stale
      : !!(
          draft.input.trim() ||
          draft.title.trim() ||
          draft.questions.length > 1 ||
          draft.questions[0]?.instructions.trim()
        );

  const resultsBadgeText = isBatch
    ? batchDoneCount > 0 || batchErrorCount > 0
      ? ` · ${batchDoneCount}/${batchNonEmptyCount || batchItems.length}`
      : ''
    : answers.length > 0
      ? ` · ${answers.length}`
      : '';

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
      <div
        className={`dec-card${isBatch || mode === 'results' ? ' is-wide' : ''}`}
      >
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
              placeholder={
                isBatch ? 'Untitled batch decision' : 'Untitled decision'
              }
              onChange={(e) => actions.setDecisionTitle(e.target.value)}
              className="dec-title-input"
            />
          </div>
          <div className="dec-head-actions">
            <div className="dec-seg" role="group" aria-label="Evaluation mode">
              <button
                type="button"
                className={`dec-seg-btn${!isBatch ? ' is-active' : ''}`}
                aria-pressed={!isBatch}
                onClick={() => actions.setDecisionBatchMode(false)}
              >
                SINGLE
              </button>
              <button
                type="button"
                className={`dec-seg-btn${isBatch ? ' is-active' : ''}`}
                aria-pressed={isBatch}
                onClick={() => actions.setDecisionBatchMode(true)}
              >
                <I n="table" s={10} w={2.2} />
                <span>
                  BATCH{batchNonEmptyCount > 0 ? ` · ${batchNonEmptyCount}` : ''}
                </span>
              </button>
            </div>
            <div className="dec-seg" role="group" aria-label="Editor view">
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
                RESULTS{resultsBadgeText}
              </button>
            </div>
            <DeleteButton id={draft.id} title={draft.title} stored={!!run} />
          </div>
        </header>

        {/* ── meta strip ── */}
        <div className="dec-meta">
          <div className="dec-meta-stats">
            {isBatch ? (
              <>
                <span>BATCH EVALUATION</span>
                <span>
                  &middot; {batchDoneCount}/{batchNonEmptyCount} DONE
                </span>
                {batchErrorCount > 0 && (
                  <span className="text-[var(--dec-danger)] font-bold">
                    &middot; {batchErrorCount} FAILED
                  </span>
                )}
                {batchTelemetry.hasTokens && (
                  <span>
                    &middot; {kfmt(batchTelemetry.promptTokens)} IN /{' '}
                    {kfmt(batchTelemetry.completionTokens)} OUT
                  </span>
                )}
                {batchTelemetry.costUsd !== undefined && (
                  <span>&middot; {$fmt(batchTelemetry.costUsd)}</span>
                )}
                {batchTelemetry.avgLatencyMs !== undefined && (
                  <span>&middot; AVG {batchTelemetry.avgLatencyMs} MS</span>
                )}
                {draft.modelId && (
                  <span className="truncate">
                    &middot; {modelName(models, draft.modelId).toUpperCase()}
                  </span>
                )}
              </>
            ) : run ? (
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

            {!isBatch ? (
              <div className="dec-sec">
                <div className="dec-sec-head">
                  <span className="dec-sec-label">
                    <b>02</b> / INPUT
                  </span>
                  <div className="dec-head-right">
                    <button
                      type="button"
                      className="dec-mini-btn"
                      onClick={() => actions.setDecisionBatchMode(true)}
                    >
                      <I n="table" s={10} w={2.2} />
                      <span>SWITCH TO BATCH</span>
                    </button>
                    <span
                      className={`dec-count${draft.input.length > MAX_DECISION_INPUT * 0.9 ? ' warn' : ''}`}
                    >
                      {draft.input.length}/{MAX_DECISION_INPUT}
                    </span>
                  </div>
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
            ) : (
              <div className="dec-sec">
                <div className="dec-sec-head">
                  <span className="dec-sec-label">
                    <b>02</b> / BATCH INPUTS
                    <span className="dec-cnum">
                      {batchItems.length}/{MAX_DECISION_BATCH_ITEMS}
                    </span>
                  </span>
                  <div className="dec-head-right">
                    <button
                      type="button"
                      className="dec-mini-btn"
                      onClick={() => {
                        actions.loadDecisionSampleBatch();
                        actions.toast('Loaded sample batch inputs', 'info');
                      }}
                    >
                      SAMPLE SET
                    </button>
                    <button
                      type="button"
                      className={`dec-mini-btn${importOpen ? ' is-active' : ''}`}
                      onClick={() => setImportOpen((o) => !o)}
                    >
                      <I n="plus" s={10} w={2.4} />
                      <span>BULK PASTE</span>
                    </button>
                    <button
                      type="button"
                      className="dec-mini-btn"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <I n="upload" s={10} w={2.4} />
                      <span>IMPORT CSV / JSON</span>
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv,.tsv,.txt,.json,.jsonl"
                      className="hidden"
                      onChange={(e) => void handleFileUpload(e)}
                    />
                    {batchItems.length > 1 && (
                      <button
                        type="button"
                        className="dec-mini-btn danger"
                        onClick={() => {
                          actions.clearDecisionBatchItems();
                          actions.toast('Cleared batch rows', 'info');
                        }}
                      >
                        CLEAR
                      </button>
                    )}
                  </div>
                </div>

                {/* Collapsible Bulk Paste / CSV Import Box */}
                {importOpen && (
                  <div className="dec-import-box">
                    <div className="dec-import-head">
                      <span className="dec-sec-label">
                        BULK PASTE / DELIMITED IMPORT
                      </span>
                      <fieldset
                        className="dec-typeseg"
                        aria-label="Import format"
                      >
                        {(
                          [
                            ['auto', 'AUTO'],
                            ['lines', 'LINES'],
                            ['blocks', 'BLOCKS (---)'],
                            ['csv', 'CSV / TSV'],
                            ['json', 'JSON / JSONL'],
                          ] as const
                        ).map(([fmtKey, fmtLabel]) => (
                          <button
                            key={fmtKey}
                            type="button"
                            className={importFmt === fmtKey ? 'is-active' : ''}
                            onClick={() => setImportFmt(fmtKey)}
                          >
                            {fmtLabel}
                          </button>
                        ))}
                      </fieldset>
                    </div>
                    <AutoTextarea
                      value={importText}
                      growKey={importFmt}
                      maxPx={180}
                      placeholder={
                        importFmt === 'csv'
                          ? 'label,input\nTKT-101,"My card was charged twice..."\nTKT-102,"Export PDF button throws a 500..."'
                          : importFmt === 'json'
                            ? '[{"label": "ROW-1", "input": "First text..."}, {"label": "ROW-2", "input": "Second text..."}]'
                            : importFmt === 'blocks'
                              ? 'First multi-line input paragraph…\n---\nSecond multi-line input paragraph…'
                              : 'Paste one input per line, CSV rows (label,input), or JSON array…'
                      }
                      onChange={(e) => setImportText(e.target.value)}
                      className="dec-input-area scroll-thin"
                    />
                    <div className="dec-import-foot">
                      <span className="dec-count">
                        {parsedImportPreview.length}{' '}
                        {parsedImportPreview.length === 1 ? 'ROW' : 'ROWS'}{' '}
                        DETECTED
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          className="dec-mini-btn"
                          onClick={() => setImportOpen(false)}
                        >
                          CANCEL
                        </button>
                        <button
                          type="button"
                          className="dec-mini-btn"
                          disabled={parsedImportPreview.length === 0}
                          onClick={() => {
                            actions.importDecisionBatchItems(
                              parsedImportPreview,
                              'replace',
                            );
                            actions.toast(
                              `Replaced batch with ${parsedImportPreview.length} rows`,
                              'info',
                            );
                            setImportText('');
                            setImportOpen(false);
                          }}
                        >
                          REPLACE ALL ({parsedImportPreview.length})
                        </button>
                        <button
                          type="button"
                          className="dec-mini-btn is-active"
                          disabled={parsedImportPreview.length === 0}
                          onClick={() => {
                            actions.importDecisionBatchItems(
                              parsedImportPreview,
                              'append',
                            );
                            actions.toast(
                              `Added ${parsedImportPreview.length} rows to batch`,
                              'info',
                            );
                            setImportText('');
                            setImportOpen(false);
                          }}
                        >
                          APPEND ({parsedImportPreview.length})
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* Editable Batch Input Rows */}
                <div className="dec-batch-list">
                  {batchItems.map((it, idx) => {
                    const rowInvalid =
                      flag?.field === 'input' &&
                      (flag.batchIndex === idx ||
                        (flag.batchIndex === 0 && batchNonEmptyCount === 0));
                    const rowShaking = rowInvalid && !!flag?.shaking;
                    const rowPreview = (it.answers ?? [])
                      .map((a) => {
                        const q = draft.questions.find(
                          (x) => x.name === a.name,
                        );
                        return `${a.name}: ${a.type === 'refusal' ? 'Refused' : headline(a, q)}`;
                      })
                      .join(' · ');

                    return (
                      <div
                        key={it.id}
                        onAnimationEnd={() =>
                          setFlag((f) => (f ? { ...f, shaking: false } : null))
                        }
                        className={`dec-batch-row${it.status === 'done' ? ' is-done' : it.status === 'error' ? ' is-err' : ''}${rowInvalid ? ' err' : ''}${rowShaking ? ' shake' : ''}`}
                      >
                        <span
                          className={`dec-badge${it.status === 'done' ? ' is-done' : it.status === 'error' ? ' is-err' : it.status === 'running' ? ' is-run' : ''}`}
                        >
                          {String(idx + 1).padStart(2, '0')}
                        </span>
                        <div className="dec-fields">
                          <div className="dec-batch-row-top">
                            <label className="dec-batch-label-wrap">
                              <span>ID</span>
                              <input
                                value={it.label ?? ''}
                                maxLength={MAX_DECISION_BATCH_LABEL}
                                spellCheck={false}
                                aria-label={`Row ${idx + 1} label`}
                                placeholder={`ITEM-${String(idx + 1).padStart(2, '0')}`}
                                onChange={(e) =>
                                  actions.updateDecisionBatchItem(idx, {
                                    label: e.target.value,
                                  })
                                }
                                className="dec-batch-label-input"
                              />
                            </label>

                            {it.status === 'done' && rowPreview && (
                              <button
                                type="button"
                                className="dec-batch-ans-preview"
                                title="View row in Results Table"
                                onClick={() => {
                                  setSelectedRowIdx(idx);
                                  setMode('results');
                                }}
                              >
                                {rowPreview}
                              </button>
                            )}
                            {it.status === 'error' && (
                              <span
                                className="dec-batch-err-tag"
                                title={it.error}
                              >
                                FAILED: {it.error}
                              </span>
                            )}
                            {(it.status === 'running' ||
                              it.status === 'queued') && (
                              <span className="dec-batch-run-tag">
                                {it.status === 'running'
                                  ? 'RUNNING…'
                                  : 'QUEUED'}
                              </span>
                            )}

                            <span
                              className={`dec-count ml-auto${it.input.length > MAX_DECISION_INPUT * 0.9 ? ' warn' : ''}`}
                            >
                              {it.input.length.toLocaleString()} chars
                            </span>
                          </div>

                          <AutoTextarea
                            textareaRef={{
                              get current() {
                                return batchInputRefs.current[idx] ?? null;
                              },
                              set current(el) {
                                batchInputRefs.current[idx] = el;
                              },
                            }}
                            value={it.input}
                            growKey={`${mode}:${batchItems.length}`}
                            maxPx={150}
                            maxLength={MAX_DECISION_INPUT}
                            aria-label={`Batch input row ${idx + 1}`}
                            placeholder={`Input text for row #${idx + 1}…`}
                            onChange={(e) => {
                              if (flag?.field === 'input') clearFlag();
                              actions.updateDecisionBatchItem(idx, {
                                input: e.target.value,
                              });
                            }}
                            className="dec-choice-desc dec-batch-textarea scroll-thin"
                          />
                        </div>

                        <div className="dec-row-tools">
                          <button
                            type="button"
                            className="dec-tool"
                            disabled={running || !it.input.trim()}
                            title="Evaluate this row"
                            aria-label={`Evaluate row ${idx + 1}`}
                            onClick={() => void handleRunSingleRow(idx)}
                          >
                            <I n="play" s={10} w={2.4} />
                          </button>
                          <button
                            type="button"
                            className="dec-tool"
                            disabled={idx === 0}
                            title="Move row up"
                            aria-label={`Move row ${idx + 1} up`}
                            onClick={() =>
                              actions.moveDecisionBatchItem(idx, -1)
                            }
                          >
                            <I n="chevron-up" s={12} w={2.6} />
                          </button>
                          <button
                            type="button"
                            className="dec-tool"
                            disabled={idx >= batchItems.length - 1}
                            title="Move row down"
                            aria-label={`Move row ${idx + 1} down`}
                            onClick={() =>
                              actions.moveDecisionBatchItem(idx, 1)
                            }
                          >
                            <I n="chevron-down-sm" s={12} w={2.6} />
                          </button>
                          <button
                            type="button"
                            className="dec-tool del"
                            disabled={
                              batchItems.length <= 1 && !it.input.trim()
                            }
                            title="Remove row"
                            aria-label={`Remove row ${idx + 1}`}
                            onClick={() => actions.removeDecisionBatchItem(idx)}
                          >
                            <I n="x" s={12} w={2.6} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <button
                  type="button"
                  className="dec-add"
                  disabled={atMaxBatch}
                  onClick={() => actions.addDecisionBatchItem()}
                >
                  <I n="plus" s={12} w={2.6} />
                  <span>
                    ADD INPUT ROW ({batchItems.length}/
                    {MAX_DECISION_BATCH_ITEMS})
                  </span>
                </button>
              </div>
            )}

            {questionRail(false)}

            {activeQuestion ? (
              <ActiveQuestionEditor
                q={activeQuestion}
                index={safeIdx}
                answer={stale || isBatch ? undefined : activeAnswer}
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
                {running && isBatch ? (
                  <button
                    type="button"
                    className="dec-btn ghost armed"
                    onClick={() => actions.stopDecisionBatch()}
                  >
                    <I n="stop" s={11} w={2.4} />
                    <span>STOP BATCH</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    className={`dec-btn ghost${resetArmed ? ' armed' : ''}`}
                    disabled={running || !canReset}
                    onClick={handleReset}
                  >
                    {resetArmed ? 'SURE?' : run && !isBatch ? 'REVERT' : 'RESET'}
                  </button>
                )}
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
                        : isBatch
                          ? batchDoneCount > 0
                            ? `RUN BATCH AGAIN (${batchNonEmptyCount})`
                            : `RUN BATCH (${batchNonEmptyCount})`
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
            {isBatch ? (
              <BatchResultsTableSection
                draft={draft}
                batchItems={batchItems}
                running={running}
                safeIdx={safeIdx}
                safeRowIdx={safeRowIdx}
                tableQuery={tableQuery}
                statusFilter={statusFilter}
                outcomeFilter={outcomeFilter}
                sortCol={sortCol}
                sortAsc={sortAsc}
                onTableQuery={setTableQuery}
                onStatusFilter={setStatusFilter}
                onOutcomeFilter={setOutcomeFilter}
                onSort={(col) => {
                  if (sortCol === col) setSortAsc((a) => !a);
                  else {
                    setSortCol(col);
                    setSortAsc(col === 'row' || col === 'input');
                  }
                }}
                onSelectCell={(rIdx, qIdx) => {
                  setSelectedRowIdx(rIdx);
                  switchQuestion(qIdx);
                }}
                onSelectRow={(rIdx) => setSelectedRowIdx(rIdx)}
                onSwitchQuestion={switchQuestion}
                onRunAll={() => void handleRun()}
                onRunRow={(rIdx) => void handleRunSingleRow(rIdx)}
                onRetryFailed={() => void handleRetryFailedRows()}
                onStop={() => actions.stopDecisionBatch()}
                onEditRowInBuild={(rIdx) => {
                  setSelectedRowIdx(rIdx);
                  setMode('build');
                  requestAnimationFrame(() => {
                    batchInputRefs.current[rIdx]?.focus();
                  });
                }}
                onSwitchToBuild={() => setMode('build')}
                questionRail={questionRail(false)}
              />
            ) : (
              <>
                {results.length > 0 && (
                  <SingleResultsTable
                    draft={draft}
                    answers={answers}
                    stale={stale}
                    safeIdx={safeIdx}
                    onSelectQuestion={switchQuestion}
                  />
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
                  <div className="dec-sec opacity-75">
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
              </>
            )}
          </section>
        )}
      </div>
    </main>
  );
}

/* ── Single-Run Results Table (01 / RESULTS TABLE in Single mode) ──── */

function SingleResultsTable({
  draft,
  answers,
  stale,
  safeIdx,
  onSelectQuestion,
}: {
  draft: DecisionDraft;
  answers: DecisionAnswer[];
  stale: boolean;
  safeIdx: number;
  onSelectQuestion: (idx: number) => void;
}) {
  const singleAsBatchItem: DecisionBatchItem = {
    id: draft.id,
    label: draft.title || 'SINGLE',
    input: draft.input,
    status: 'done',
    answers,
  };

  return (
    <div className={`dec-sec${stale ? ' opacity-75' : ''}`}>
      <div className="dec-sec-head">
        <span className="dec-sec-label">
          <b>01</b> / RESULTS TABLE
          <span className="dec-cnum">
            {answers.length}/{draft.questions.length}
          </span>
        </span>
        <div className="dec-head-right">
          {stale && (
            <span className="dec-status warn">
              STALE &middot; FROM BEFORE YOUR EDITS
            </span>
          )}
          <ExportToolbar
            draft={draft}
            items={[singleAsBatchItem]}
          />
        </div>
      </div>

      <div className="dec-table-wrap scroll-thin">
        <table className="dec-table" aria-label="Single decision results table">
          <thead>
            <tr>
              <th className="w-[40px]">#</th>
              <th>KEY</th>
              <th className="w-[86px]">TYPE</th>
              <th>QUESTION</th>
              <th>RESULT</th>
              <th className="w-[140px]">CONFIDENCE / PROB</th>
            </tr>
          </thead>
          <tbody>
            {draft.questions.map((q, i) => {
              const a = answers.find((x) => x.name === q.name);
              const bar = a ? answerBar(a) : null;
              const isSelected = i === safeIdx;
              return (
                <tr
                  // biome-ignore lint/suspicious/noArrayIndexKey: matches question rail positions
                  key={i}
                  onClick={() => onSelectQuestion(i)}
                  className={`dec-tr-interactive${isSelected ? ' is-selected' : ''}`}
                >
                  <td>
                    <span className="dec-badge">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                  </td>
                  <td className="font-mono text-[11.5px] font-bold">
                    {q.name || `q_${i + 1}`}
                  </td>
                  <td>
                    <span className="dec-model-tag">{TYPE_NAME[q.type]}</span>
                  </td>
                  <td className="max-w-[260px] truncate text-[12px] text-[var(--dec-muted)]">
                    {q.instructions || '—'}
                  </td>
                  <td>
                    {a ? (
                      <AnswerCellBadge a={a} q={q} />
                    ) : (
                      <span className="dec-cell-empty">—</span>
                    )}
                  </td>
                  <td>
                    {bar !== null ? (
                      <div className="flex items-center gap-2">
                        <span className="flex-1 min-w-[56px]">
                          <BrutalistBar
                            v={bar}
                            label={`${q.name} ${a?.type === 'predicate' ? 'probability' : 'confidence'}`}
                          />
                        </span>
                        <span className="dec-count w-[36px] text-right">
                          {pct(bar)}
                        </span>
                      </div>
                    ) : (
                      <span className="dec-cell-empty">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ── Batch Results Table & Inspector Section ──────────────────────── */

function BatchResultsTableSection({
  draft,
  batchItems,
  running,
  safeIdx,
  safeRowIdx,
  tableQuery,
  statusFilter,
  outcomeFilter,
  sortCol,
  sortAsc,
  onTableQuery,
  onStatusFilter,
  onOutcomeFilter,
  onSort,
  onSelectCell,
  onSelectRow,
  onSwitchQuestion,
  onRunAll,
  onRunRow,
  onRetryFailed,
  onStop,
  onEditRowInBuild,
  onSwitchToBuild,
  questionRail,
}: {
  draft: DecisionDraft;
  batchItems: DecisionBatchItem[];
  running: boolean;
  safeIdx: number;
  safeRowIdx: number;
  tableQuery: string;
  statusFilter: BatchStatusFilter;
  outcomeFilter: { questionName: string; value: string } | null;
  sortCol: BatchSortCol;
  sortAsc: boolean;
  onTableQuery: (q: string) => void;
  onStatusFilter: (f: BatchStatusFilter) => void;
  onOutcomeFilter: (
    f: { questionName: string; value: string } | null,
  ) => void;
  onSort: (col: BatchSortCol) => void;
  onSelectCell: (rowIdx: number, qIdx: number) => void;
  onSelectRow: (rowIdx: number) => void;
  onSwitchQuestion: (qIdx: number) => void;
  onRunAll: () => void;
  onRunRow: (rowIdx: number) => void;
  onRetryFailed: () => void;
  onStop: () => void;
  onEditRowInBuild: (rowIdx: number) => void;
  onSwitchToBuild: () => void;
  questionRail: React.ReactNode;
}) {
  const nonEmptyTotal = batchItems.filter(
    (it) => it.input.trim() !== '',
  ).length;
  const doneCount = batchItems.filter((it) => it.status === 'done').length;
  const errorCount = batchItems.filter((it) => it.status === 'error').length;
  const runningCount = batchItems.filter(
    (it) => it.status === 'running' || it.status === 'queued',
  ).length;
  const refusedRowCount = batchItems.filter((it) =>
    (it.answers ?? []).some((a) => a.type === 'refusal'),
  ).length;

  const progressRatio =
    nonEmptyTotal > 0
      ? Math.min(1, (doneCount + errorCount) / nonEmptyTotal)
      : 0;

  /* per-question aggregate summaries */
  const summaries = useMemo(
    () => draft.questions.map((q) => summarizeBatchQuestion(q, batchItems)),
    [draft.questions, batchItems],
  );

  /* filter & sort rows while keeping original row index */
  const visibleRows = useMemo(() => {
    const q = tableQuery.trim().toLowerCase();
    const indexed = batchItems.map((item, idx) => ({ item, idx }));

    const filtered = indexed.filter(({ item }) => {
      if (statusFilter === 'done' && item.status !== 'done') return false;
      if (statusFilter === 'error' && item.status !== 'error') return false;
      if (
        statusFilter === 'refused' &&
        !(item.answers ?? []).some((a) => a.type === 'refusal')
      )
        return false;

      if (outcomeFilter) {
        const ans = item.answers?.find(
          (a) => a.name === outcomeFilter.questionName,
        );
        if (!ans || ans.type === 'refusal') return false;
        if (ans.type === 'predicate') {
          const isTrue = (ans.probability ?? 0) >= 0.5;
          if ((isTrue ? 'TRUE' : 'FALSE') !== outcomeFilter.value) return false;
        } else if (ans.type === 'choice') {
          if (ans.choice !== outcomeFilter.value) return false;
        }
      }

      if (q) {
        const hay = [
          item.label ?? '',
          item.input,
          item.error ?? '',
          ...(item.answers ?? []).map((a) => {
            const question = draft.questions.find((x) => x.name === a.name);
            return `${a.name} ${headline(a, question)}`;
          }),
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const dir = sortAsc ? 1 : -1;
    filtered.sort((a, b) => {
      if (sortCol === 'row') return (a.idx - b.idx) * dir;
      if (sortCol === 'input') {
        const la = (a.item.label || a.item.input).toLowerCase();
        const lb = (b.item.label || b.item.input).toLowerCase();
        return la.localeCompare(lb) * dir;
      }
      if (sortCol === 'latency') {
        const ta = a.item.latencyMs ?? -1;
        const tb = b.item.latencyMs ?? -1;
        return (ta - tb) * dir;
      }
      if (sortCol.startsWith('q:')) {
        const qName = sortCol.slice(2);
        const qa = a.item.answers?.find((x) => x.name === qName);
        const qb = b.item.answers?.find((x) => x.name === qName);
        const rank = (ans: DecisionAnswer | undefined): number | string => {
          if (!ans) return -999;
          if (ans.type === 'refusal') return -998;
          if (ans.type === 'predicate') return ans.probability ?? -1;
          if (ans.type === 'score') return ans.score ?? -1;
          return ans.choice ?? '';
        };
        const va = rank(qa);
        const vb = rank(qb);
        if (typeof va === 'number' && typeof vb === 'number')
          return (va - vb) * dir;
        return String(va).localeCompare(String(vb)) * dir;
      }
      return 0;
    });

    return filtered;
  }, [
    batchItems,
    tableQuery,
    statusFilter,
    outcomeFilter,
    sortCol,
    sortAsc,
    draft.questions,
  ]);

  const selectedRow = batchItems[safeRowIdx];
  const activeQuestion = draft.questions[safeIdx];
  const activeRowAnswer =
    selectedRow && activeQuestion
      ? selectedRow.answers?.find((a) => a.name === activeQuestion.name)
      : undefined;

  return (
    <>
      {/* ── Live Progress & Batch Controls Strip ── */}
      <div className="dec-batch-bar">
        <div className="dec-batch-progress-info">
          <span
            className={`dec-status ${running ? 'ok' : errorCount > 0 ? 'warn' : doneCount > 0 ? 'ok' : ''}`}
          >
            {running
              ? `EVALUATING BATCH · ${doneCount + errorCount}/${nonEmptyTotal} COMPLETED (${runningCount} ACTIVE)`
              : doneCount > 0 || errorCount > 0
                ? `BATCH RESULTS · ${doneCount} DONE${errorCount > 0 ? ` · ${errorCount} FAILED` : ''}`
                : `READY TO EVALUATE ${nonEmptyTotal} ${nonEmptyTotal === 1 ? 'ROW' : 'ROWS'}`}
          </span>
          {(running || doneCount > 0 || errorCount > 0) && (
            <span className="w-[140px] sm:w-[200px]">
              <BrutalistBar
                v={progressRatio}
                label="Batch completion progress"
              />
            </span>
          )}
        </div>
        <div className="dec-head-right">
          {running && (
            <button
              type="button"
              className="dec-mini-btn danger"
              onClick={onStop}
            >
              <I n="stop" s={10} w={2.4} />
              <span>STOP</span>
            </button>
          )}
          {!running && errorCount > 0 && (
            <button
              type="button"
              className="dec-mini-btn danger"
              onClick={onRetryFailed}
            >
              <I n="rotate-cw" s={10} w={2.4} />
              <span>RETRY FAILED ({errorCount})</span>
            </button>
          )}
          <ExportToolbar draft={draft} items={batchItems} />
        </div>
      </div>

      {/* ── 01 / Aggregate Summary Cards across Batch ── */}
      {doneCount > 0 && (
        <div className="dec-sec">
          <div className="dec-sec-head">
            <span className="dec-sec-label">
              <b>01</b> / AGGREGATE SUMMARY
              <span className="dec-cnum">
                {doneCount} EVALUATED {doneCount === 1 ? 'ROW' : 'ROWS'}
              </span>
            </span>
            <span className="dec-hint">
              CLICK A CHIP TO FILTER THE TABLE BELOW
            </span>
          </div>
          <div className="dec-agg-grid">
            {summaries.map((s, qIdx) => {
              const q = s.question;
              const isFocusedQ = qIdx === safeIdx;
              return (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: matches question positions
                  key={qIdx}
                  className={`dec-agg-card${isFocusedQ ? ' is-active' : ''}`}
                >
                  <div className="dec-agg-head">
                    <button
                      type="button"
                      onClick={() => onSwitchQuestion(qIdx)}
                      className="dec-agg-title-btn"
                    >
                      <span className="dec-badge">
                        {String(qIdx + 1).padStart(2, '0')}
                      </span>
                      <span className="truncate font-mono text-[11.5px] font-bold">
                        {q.name}
                      </span>
                    </button>
                    <span className="dec-model-tag">{TYPE_NAME[q.type]}</span>
                  </div>

                  {q.type === 'predicate' && (
                    <div className="dec-agg-body">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-mono text-[15px] font-extrabold text-[var(--dec-accent)]">
                          {s.trueRate !== null && s.trueRate !== undefined
                            ? `${pct(s.trueRate)} TRUE`
                            : '—'}
                        </span>
                        <span className="dec-count">
                          AVG{' '}
                          {s.avgProbability !== null &&
                          s.avgProbability !== undefined
                            ? pct(s.avgProbability)
                            : '—'}
                        </span>
                      </div>
                      {s.trueRate !== null && s.trueRate !== undefined && (
                        <BrutalistBar
                          v={s.trueRate}
                          label={`${q.name} true rate`}
                        />
                      )}
                      <div className="dec-agg-chips">
                        {(['TRUE', 'FALSE'] as const).map((val) => {
                          const cnt =
                            val === 'TRUE'
                              ? (s.trueCount ?? 0)
                              : (s.falseCount ?? 0);
                          const active =
                            outcomeFilter?.questionName === q.name &&
                            outcomeFilter.value === val;
                          return (
                            <button
                              key={val}
                              type="button"
                              onClick={() =>
                                onOutcomeFilter(
                                  active
                                    ? null
                                    : { questionName: q.name, value: val },
                                )
                              }
                              className={`dec-agg-chip${active ? ' is-active' : ''}`}
                            >
                              <span>{val}</span>
                              <b>{cnt}</b>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {q.type === 'choice' && (
                    <div className="dec-agg-body">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-mono text-[14px] font-extrabold text-[var(--dec-accent)]">
                          {s.topChoice
                            ? `${s.topChoice.value} (${pct(s.topChoice.share)})`
                            : '—'}
                        </span>
                        {s.avgConfidence !== null &&
                          s.avgConfidence !== undefined && (
                            <span className="dec-count">
                              CONF {pct(s.avgConfidence)}
                            </span>
                          )}
                      </div>
                      <div className="dec-agg-chips">
                        {(s.choiceCounts ?? []).map((cc) => {
                          const active =
                            outcomeFilter?.questionName === q.name &&
                            outcomeFilter.value === cc.value;
                          return (
                            <button
                              key={cc.value}
                              type="button"
                              onClick={() =>
                                onOutcomeFilter(
                                  active
                                    ? null
                                    : {
                                        questionName: q.name,
                                        value: cc.value,
                                      },
                                )
                              }
                              className={`dec-agg-chip${active ? ' is-active' : ''}`}
                            >
                              <span className="truncate max-w-[96px]">
                                {cc.value}
                              </span>
                              <b>{cc.count}</b>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {q.type === 'score' && (
                    <div className="dec-agg-body">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-mono text-[14px] font-extrabold text-[var(--dec-accent)]">
                          {s.avgScore !== null && s.avgScore !== undefined
                            ? `${s.nearestLabel ? `${s.nearestLabel} · ` : ''}${s.avgScore.toFixed(2)}`
                            : '—'}
                        </span>
                        <span className="dec-count">
                          / {s.maxLevelIndex ?? 1}
                        </span>
                      </div>
                      {s.avgScore !== null && s.avgScore !== undefined && (
                        <BrutalistBar
                          v={s.avgScore / Math.max(1, s.maxLevelIndex ?? 1)}
                          label={`${q.name} average score`}
                        />
                      )}
                      {s.minScore !== null &&
                        s.minScore !== undefined &&
                        s.maxScore !== null &&
                        s.maxScore !== undefined && (
                          <div className="dec-count">
                            MIN {s.minScore.toFixed(2)} &middot; MAX{' '}
                            {s.maxScore.toFixed(2)}
                          </div>
                        )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── 02 / Results Table ── */}
      <div className="dec-sec">
        <div className="dec-sec-head">
          <span className="dec-sec-label">
            <b>{doneCount > 0 ? '02' : '01'}</b> / RESULTS TABLE
            <span className="dec-cnum">
              {visibleRows.length}/{batchItems.length} ROWS
            </span>
          </span>
          <span className="dec-hint">
            CLICK ANY CELL TO INSPECT FULL DISTRIBUTION BELOW
          </span>
        </div>

        {/* Table Filter & Search Toolbar */}
        <div className="dec-table-toolbar">
          <div className="dec-table-search">
            <I n="search" s={12} w={2.2} className="text-[var(--dec-muted)]" />
            <input
              type="text"
              value={tableQuery}
              placeholder="Filter inputs, labels, or answers…"
              aria-label="Filter results table"
              onChange={(e) => onTableQuery(e.target.value)}
              className="dec-table-search-input"
            />
            {tableQuery && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => onTableQuery('')}
                className="dec-tool"
              >
                <I n="x" s={11} w={2.4} />
              </button>
            )}
          </div>

          {outcomeFilter && (
            <button
              type="button"
              onClick={() => onOutcomeFilter(null)}
              className="dec-mini-btn is-active"
              title="Clear outcome filter"
            >
              <span>
                {outcomeFilter.questionName} = {outcomeFilter.value}
              </span>
              <I n="x" s={10} w={2.6} />
            </button>
          )}

          <fieldset
            className="dec-typeseg ml-auto"
            aria-label="Filter rows by status"
          >
            {(
              [
                ['all', `ALL (${batchItems.length})`],
                ['done', `DONE (${doneCount})`],
                ...(errorCount > 0
                  ? ([['error', `FAILED (${errorCount})`]] as const)
                  : []),
                ...(refusedRowCount > 0
                  ? ([['refused', `REFUSED (${refusedRowCount})`]] as const)
                  : []),
              ] as const
            ).map(([fKey, fLabel]) => (
              <button
                key={fKey}
                type="button"
                className={statusFilter === fKey ? 'is-active' : ''}
                onClick={() => onStatusFilter(fKey)}
              >
                {fLabel}
              </button>
            ))}
          </fieldset>
        </div>

        <div className="dec-table-wrap scroll-thin">
          <table className="dec-table" aria-label="Batch decision results">
            <thead>
              <tr>
                <th className="w-[46px]">
                  <button
                    type="button"
                    className="dec-th-btn"
                    onClick={() => onSort('row')}
                  >
                    <span>#</span>
                    {sortCol === 'row' && (
                      <span className="dec-sort-ind">
                        {sortAsc ? '▲' : '▼'}
                      </span>
                    )}
                  </button>
                </th>
                <th className="min-w-[200px]">
                  <button
                    type="button"
                    className="dec-th-btn"
                    onClick={() => onSort('input')}
                  >
                    <span>INPUT</span>
                    {sortCol === 'input' && (
                      <span className="dec-sort-ind">
                        {sortAsc ? '▲' : '▼'}
                      </span>
                    )}
                  </button>
                </th>
                {draft.questions.map((q, qIdx) => {
                  const colKey: BatchSortCol = `q:${q.name}`;
                  const isSorted = sortCol === colKey;
                  const isFocusedCol = qIdx === safeIdx;
                  return (
                    <th
                      // biome-ignore lint/suspicious/noArrayIndexKey: matches question columns
                      key={qIdx}
                      className={`min-w-[148px]${isFocusedCol ? ' is-focused-col' : ''}`}
                    >
                      <button
                        type="button"
                        className="dec-th-btn"
                        onClick={() => onSort(colKey)}
                      >
                        <span className="dec-th-num">
                          {String(qIdx + 1).padStart(2, '0')}
                        </span>
                        <span className="truncate">{q.name}</span>
                        <span className="dec-th-type">{TYPE_TAG[q.type]}</span>
                        {isSorted && (
                          <span className="dec-sort-ind">
                            {sortAsc ? '▲' : '▼'}
                          </span>
                        )}
                      </button>
                    </th>
                  );
                })}
                <th className="w-[104px]">
                  <button
                    type="button"
                    className="dec-th-btn"
                    onClick={() => onSort('latency')}
                  >
                    <span>STAT</span>
                    {sortCol === 'latency' && (
                      <span className="dec-sort-ind">
                        {sortAsc ? '▲' : '▼'}
                      </span>
                    )}
                  </button>
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={draft.questions.length + 3}
                    className="py-6 text-center font-mono text-[11px] text-[var(--dec-muted)]"
                  >
                    NO MATCHING ROWS
                  </td>
                </tr>
              ) : (
                visibleRows.map(({ item: it, idx: rowIdx }) => {
                  const isRowSel = rowIdx === safeRowIdx;
                  return (
                    <tr
                      key={it.id}
                      onClick={() => onSelectRow(rowIdx)}
                      className={`dec-tr-interactive${isRowSel ? ' is-selected' : ''}`}
                    >
                      <td>
                        <span
                          className={`dec-badge${it.status === 'done' ? ' is-done' : it.status === 'error' ? ' is-err' : it.status === 'running' ? ' is-run' : ''}`}
                        >
                          {String(rowIdx + 1).padStart(2, '0')}
                        </span>
                      </td>
                      <td className="dec-td-input">
                        {it.label && (
                          <div className="dec-td-label">{it.label}</div>
                        )}
                        <div className="dec-td-text" title={it.input}>
                          {it.input.trim() || (
                            <span className="italic text-[var(--dec-faint)]">
                              Empty input
                            </span>
                          )}
                        </div>
                        {it.error && (
                          <div className="dec-td-err" title={it.error}>
                            {it.error}
                          </div>
                        )}
                      </td>
                      {draft.questions.map((q, qIdx) => {
                        const a = it.answers?.find((x) => x.name === q.name);
                        const isFocusedCell = isRowSel && qIdx === safeIdx;
                        return (
                          <td
                            // biome-ignore lint/suspicious/noArrayIndexKey: matches question columns
                            key={qIdx}
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectCell(rowIdx, qIdx);
                            }}
                            className={`dec-td-ans${isFocusedCell ? ' is-focused-cell' : ''}`}
                          >
                            {it.status === 'running' ||
                            it.status === 'queued' ? (
                              <span className="dec-cell-status run">
                                {it.status === 'running'
                                  ? 'RUNNING…'
                                  : 'QUEUED'}
                              </span>
                            ) : it.status === 'error' ? (
                              <span
                                className="dec-cell-status err"
                                title={it.error}
                              >
                                FAILED
                              </span>
                            ) : a ? (
                              <AnswerCellBadge a={a} q={q} showBar />
                            ) : (
                              <span className="dec-cell-empty">—</span>
                            )}
                          </td>
                        );
                      })}
                      <td
                        onClick={(e) => e.stopPropagation()}
                        className="dec-td-stat"
                      >
                        <div className="flex items-center justify-between gap-1">
                          <div className="flex flex-col">
                            <span
                              className={`dec-cell-status ${
                                it.status === 'done'
                                  ? 'ok'
                                  : it.status === 'error'
                                    ? 'err'
                                    : it.status === 'running' ||
                                        it.status === 'queued'
                                      ? 'run'
                                      : ''
                              }`}
                            >
                              {it.status.toUpperCase()}
                            </span>
                            {it.latencyMs !== undefined && (
                              <span className="dec-count">
                                {it.latencyMs}ms
                              </span>
                            )}
                          </div>
                          <button
                            type="button"
                            className="dec-tool"
                            disabled={running || !it.input.trim()}
                            title="Re-evaluate this row"
                            aria-label={`Re-evaluate row ${rowIdx + 1}`}
                            onClick={() => onRunRow(rowIdx)}
                          >
                            <I n="rotate-cw" s={11} w={2.4} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── 03 / Selected Row & Question Probability Inspector ── */}
      {selectedRow && (
        <>
          <div className="dec-sec dec-inspect-head">
            <div className="dec-sec-head">
              <span className="dec-sec-label">
                <b>{doneCount > 0 ? '03' : '02'}</b> / INSPECT ROW #
                {String(safeRowIdx + 1).padStart(2, '0')}
                {selectedRow.label && (
                  <span className="dec-cnum">({selectedRow.label})</span>
                )}
              </span>
              <div className="dec-head-right">
                <button
                  type="button"
                  className="dec-qstep"
                  disabled={safeRowIdx <= 0}
                  title="Previous row"
                  aria-label="Previous row"
                  onClick={() => onSelectRow(Math.max(0, safeRowIdx - 1))}
                >
                  <I n="chevron-left" s={12} w={2.4} />
                </button>
                <span className="dec-count">
                  ROW {safeRowIdx + 1}/{batchItems.length}
                </span>
                <button
                  type="button"
                  className="dec-qstep"
                  disabled={safeRowIdx >= batchItems.length - 1}
                  title="Next row"
                  aria-label="Next row"
                  onClick={() =>
                    onSelectRow(
                      Math.min(batchItems.length - 1, safeRowIdx + 1),
                    )
                  }
                >
                  <I n="chevron-right" s={12} w={2.4} />
                </button>
                <button
                  type="button"
                  className="dec-mini-btn"
                  disabled={running || !selectedRow.input.trim()}
                  onClick={() => onRunRow(safeRowIdx)}
                >
                  <I n="rotate-cw" s={10} w={2.4} />
                  <span>RE-RUN ROW</span>
                </button>
                <button
                  type="button"
                  className="dec-mini-btn"
                  onClick={() => onEditRowInBuild(safeRowIdx)}
                >
                  EDIT ROW
                </button>
              </div>
            </div>
            <div className="dec-inspect-quote">
              {selectedRow.input.trim() || (
                <span className="italic text-[var(--dec-faint)]">
                  Empty input row
                </span>
              )}
            </div>
          </div>

          {questionRail}

          {activeQuestion && (
            <QuestionResultView
              q={activeQuestion}
              index={safeIdx}
              total={draft.questions.length}
              answer={activeRowAnswer}
              stale={false}
            />
          )}
        </>
      )}

      <footer className="dec-foot">
        <span
          className={
            running
              ? 'dec-status ok'
              : errorCount > 0
                ? 'dec-status warn'
                : doneCount > 0
                  ? 'dec-status ok'
                  : 'dec-status'
          }
          aria-live="polite"
        >
          {running
            ? `EVALUATING BATCH (${doneCount + errorCount}/${nonEmptyTotal})…`
            : doneCount > 0
              ? `EVALUATED · ${doneCount}/${nonEmptyTotal} ROWS COMPLETED`
              : 'NOT EVALUATED YET · PRESS RUN BATCH'}
        </span>
        <div className="dec-foot-btns">
          {running ? (
            <button
              type="button"
              className="dec-btn ghost armed"
              onClick={onStop}
            >
              <I n="stop" s={11} w={2.4} />
              <span>STOP BATCH</span>
            </button>
          ) : (
            <button
              type="button"
              className="dec-btn ghost"
              onClick={onSwitchToBuild}
            >
              EDIT IN BUILD
            </button>
          )}
          <Tip label="Run Batch · ⌘↵" side="top">
            <button
              type="button"
              className="dec-btn solid"
              disabled={running}
              onClick={onRunAll}
            >
              {running ? (
                <span className="block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <I n="play" s={11} w={2.4} />
              )}
              <span>
                {running
                  ? 'RUNNING…'
                  : doneCount > 0
                    ? `RUN BATCH AGAIN (${nonEmptyTotal})`
                    : `RUN BATCH (${nonEmptyTotal})`}
              </span>
            </button>
          </Tip>
        </div>
      </footer>
    </>
  );
}

function AnswerCellBadge({
  a,
  q,
  showBar = false,
}: {
  a: DecisionAnswer;
  q: DecisionQuestion | undefined;
  showBar?: boolean;
}) {
  if (a.type === 'refusal') {
    return <span className="dec-cell-status err">REFUSED</span>;
  }
  const bar = answerBar(a);
  if (a.type === 'predicate') {
    const prob = a.probability;
    const isTrue = prob !== undefined && prob >= 0.5;
    return (
      <div className="dec-cell-ans">
        <div className="flex items-center justify-between gap-1.5">
          <span className={`dec-ans-pill ${isTrue ? 'is-true' : 'is-false'}`}>
            {prob === undefined ? '—' : isTrue ? 'TRUE' : 'FALSE'}
          </span>
          {prob !== undefined && (
            <span className="dec-cell-pct">{pct(prob)}</span>
          )}
        </div>
        {showBar && bar !== null && (
          <BrutalistBar v={bar} label={`${a.name} probability`} />
        )}
      </div>
    );
  }
  if (a.type === 'choice') {
    return (
      <div className="dec-cell-ans">
        <div className="flex items-center justify-between gap-1.5">
          <span className="dec-ans-pill is-choice truncate">
            {a.choice ?? '—'}
          </span>
          {bar !== null && <span className="dec-cell-pct">{pct(bar)}</span>}
        </div>
        {showBar && bar !== null && (
          <BrutalistBar v={bar} label={`${a.name} confidence`} />
        )}
      </div>
    );
  }
  /* score */
  const maxLvl = Math.max(1, (q?.levels?.length ?? 2) - 1);
  const scoreRatio =
    a.score !== undefined ? Math.max(0, Math.min(1, a.score / maxLvl)) : bar;
  return (
    <div className="dec-cell-ans">
      <div className="flex items-center justify-between gap-1.5">
        <span className="dec-ans-pill is-score truncate">
          {headline(a, q)}
        </span>
        {a.confidence !== undefined && (
          <span className="dec-cell-pct">{pct(a.confidence)}</span>
        )}
      </div>
      {showBar && scoreRatio !== null && scoreRatio !== undefined && (
        <BrutalistBar v={scoreRatio} label={`${a.name} score`} />
      )}
    </div>
  );
}

function ExportToolbar({
  draft,
  items,
}: {
  draft: DecisionDraft;
  items: DecisionBatchItem[];
}) {
  const baseName = slugifyTitle(draft.title);
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className="dec-mini-btn"
        title="Copy table as TSV for spreadsheets"
        onClick={async () => {
          const tsv = formatBatchTsv(draft.questions, items);
          try {
            await navigator.clipboard.writeText(tsv);
            actions.toast('Copied table (TSV) to clipboard', 'info');
          } catch {
            actions.toast('Clipboard copy failed', 'error');
          }
        }}
      >
        <I n="copy" s={10} w={2.2} />
        <span>COPY TSV</span>
      </button>
      <button
        type="button"
        className="dec-mini-btn"
        title="Download CSV"
        onClick={() => {
          const csv = formatBatchCsv(draft.questions, items);
          downloadFile(`${baseName}.csv`, csv, 'text/csv;charset=utf-8');
        }}
      >
        <I n="download" s={10} w={2.2} />
        <span>CSV</span>
      </button>
      <button
        type="button"
        className="dec-mini-btn"
        title="Download JSON"
        onClick={() => {
          const json = formatBatchJson(draft, items);
          downloadFile(`${baseName}.json`, json, 'application/json');
        }}
      >
        <I n="json" s={10} w={2.2} />
        <span>JSON</span>
      </button>
    </div>
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
    <div className={`dec-pv${stale ? ' opacity-75' : ''}`}>
      <div className="dec-pv-label">
        <span>
          {total > 1 ? `Q${index + 1}/${total} · ` : ''}
          {TYPE_NAME[q.type]} &middot; KEY: {q.name || 'unnamed'}
        </span>
        {answer ? (
          answer.type === 'refusal' ? (
            <span className="dec-pv-key is-err">ANSWER: REFUSED</span>
          ) : (
            <span className="dec-pv-key is-set">
              ANSWER: {headline(answer, q)}
              {answer.confidence !== undefined
                ? ` · CONF ${pct(answer.confidence)}`
                : ''}
            </span>
          )
        ) : (
          <span className="dec-pv-key">ANSWER: &mdash;</span>
        )}
      </div>

      <div className={`dec-pv-q${prompt ? '' : ' is-ghost'}`}>
        {prompt || 'Untitled question prompt'}
      </div>

      {answer?.type === 'refusal' && (
        <div className="mb-2.5 rounded-[2px] border-2 border-[var(--dec-danger)] bg-[var(--dec-danger-tint)] px-2.5 py-2 font-mono text-[11px] font-semibold text-[var(--dec-danger)]">
          The model declined to answer this question.
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
                      <span className="w-[72px] sm:w-[96px]">
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
                      <span className="w-[72px] sm:w-[96px]">
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
                      <span className="w-[72px] sm:w-[96px]">
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
    <div className="dec-sum-row cursor-default">
      <span className="w-[120px] shrink-0 truncate font-mono text-[10.5px] font-semibold text-[var(--dec-muted)]">
        {a.name}
      </span>
      <span className="dec-model-tag">{a.type.toUpperCase()}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] font-bold">
        {a.type === 'refusal' ? 'Refused' : headline(a, undefined)}
      </span>
      {bar !== null && (
        <span className="hidden w-[64px] shrink-0 sm:block">
          <BrutalistBar v={bar} label={`${a.name} confidence`} />
        </span>
      )}
      {a.confidence !== undefined && (
        <span className="dec-count w-[34px] shrink-0 text-right">
          {pct(a.confidence)}
        </span>
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
        <I n="trash" s={12} w={2.2} />
      </button>
    </Tip>
  );
}

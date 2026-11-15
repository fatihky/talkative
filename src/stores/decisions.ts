/*
 * DecisionsStore — the /decisions screens: the run list, the editor's draft
 * (single and batch) and the evaluation itself.
 *
 * Business logic:
 * - runs are server-owned and, like memories, deliberately not cached in
 *   localStorage nor loaded at boot: the screens refetch on mount, so a deep
 *   link never shows somebody's stale answers. The list is sorted by
 *   updatedAt desc, which floats a re-run to the top.
 * - the editor works on a DecisionDraft (lib/decisions.ts) that is mirrored
 *   to localStorage 'decisions.draft' as it is typed, so a reload keeps an
 *   unevaluated run (and any batch rows/results); evaluating a single run
 *   clears it, because from then on the row is the source of truth.
 * - batch mode evaluates multiple input rows client-side against the stateless
 *   `POST /api/decisions` (`stateless: true`) endpoint with bounded concurrency
 *   (3 in parallel), updating each row's status (`queued` → `running` → `done`
 *   | `error`) live as responses arrive and supporting per-row retry, failed-row
 *   retry, and aborting in-flight requests.
 * - newDecision mints the id client-side and routes straight into the
 *   editor, and openDecision prefers the cached draft for that id over the
 *   server's copy — a draft that was never run has no row. Once a draft is on
 *   screen it is never overwritten by a load, so a refetch can't clobber
 *   edits in progress.
 * - the model pick sticks: 'decisions.lastModel' is written on every
 *   successful run and seeds the next draft, falling back to the catalog's
 *   first `kind: 'decision'` model.
 * - runDecision gates on decisionProblems() before spending a request, then
 *   POSTs; the route answers 200 with the run even when the provider failed,
 *   so an upstream failure lands in runError (and a toast) with the row
 *   stored, while a 4xx/5xx or a dropped connection throws into the same
 *   runError.
 * - title edits patch the draft at once and queue one debounced PATCH (500ms)
 *   for a run that already exists; flushDecisionTitle sends it on the way out
 *   of the editor, and a blank title is never sent (the server rejects it).
 * - deleteDecision removes locally first and restores the list on failure;
 *   a draft that was never run has no row, so it is only discarded locally.
 */
'use client';

import { create } from 'zustand';
import { decisionsApi, fetchDecisions } from '../lib/api';
import {
  DECISION_EXAMPLES,
  type DecisionBatchItem,
  type DecisionDraft,
  type DecisionExample,
  decisionProblems,
  exampleBatchInputs,
  MAX_DECISION_BATCH_ITEMS,
  MAX_DECISION_LEVELS,
  newBatchItem,
  newQuestion,
} from '../lib/decisions';
import { isDecisionCapable } from '../lib/models';
import { debouncedSet, LS, uuid } from '../lib/storage';
import type {
  DecisionQuestion,
  DecisionQuestionType,
  DecisionRun,
} from '../types';
import { errorText, useModelsStore } from './models';
import { useNetworkStore } from './network';
import { uiActions } from './ui';

type DecisionsState = {
  items: DecisionRun[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string | undefined;
  /* the run being edited; null outside the editor */
  draft: DecisionDraft | null;
  /* true between the POST and its answer (or while a batch is evaluating) */
  running: boolean;
  /* the last attempt's failure, from the stored run or from the request itself */
  runError?: string | undefined;
};

export const useDecisionsStore = create<DecisionsState>()(() => ({
  items: [],
  status: 'idle',
  draft: null,
  running: false,
}));

const set = useDecisionsStore.setState;
const get = useDecisionsStore.getState;

const TITLE_DELAY_MS = 500;
const DEFAULT_BATCH_CONCURRENCY = 3;

let batchAbort: AbortController | null = null;

/* a draft never shares structure with the stored run it came from */
const cloneQuestion = (q: DecisionQuestion): DecisionQuestion => ({
  ...q,
  ...(q.criteria ? { criteria: { ...q.criteria } } : {}),
  ...(q.choices ? { choices: q.choices.map((c) => ({ ...c })) } : {}),
  ...(q.levels ? { levels: q.levels.map((l) => ({ ...l })) } : {}),
});

const sanitizeCachedBatchItems = (
  items: DecisionBatchItem[] | undefined,
): DecisionBatchItem[] | undefined =>
  items?.map((it) => ({
    ...it,
    /* a page reload mid-run leaves no active fetch behind */
    status:
      it.status === 'running' || it.status === 'queued' ? 'idle' : it.status,
  }));

const toDraft = (r: DecisionRun, cached?: DecisionDraft | null): DecisionDraft => ({
  id: r.id,
  modelId: r.modelId,
  title: r.title,
  input: r.input,
  questions: r.questions.map(cloneQuestion),
  ...(cached?.batchMode !== undefined ? { batchMode: cached.batchMode } : {}),
  ...(cached?.batchItems
    ? { batchItems: sanitizeCachedBatchItems(cached.batchItems) }
    : {}),
});

/* newest edit first, so a re-run floats to the top of the list */
const sorted = (items: DecisionRun[]) =>
  [...items].sort((a, b) => b.updatedAt - a.updatedAt);

export const setDecisionItems = (items: DecisionRun[]) =>
  set({ items: sorted(items) });

const upsert = (items: DecisionRun[], run: DecisionRun) =>
  sorted(
    items.some((r) => r.id === run.id)
      ? items.map((r) => (r.id === run.id ? run : r))
      : [run, ...items],
  );

/* the last successful pick, else the catalog's first decision-capable model
   (a decision model or a System One model) */
const defaultModelId = (): string => {
  const last = LS.get<string>('decisions.lastModel', '');
  const items = useModelsStore.getState().items;
  if (items.length === 0) return last;
  /* the stored pick must still be offered: an id the catalog dropped (hidden
     or removed override) would leave the run without a model */
  if (last && items.some((m) => m.id === last)) return last;
  return items.find(isDecisionCapable)?.id ?? '';
};

const persist = (draft: DecisionDraft) => {
  set({ draft });
  debouncedSet('decisions.draft', draft);
};

/* patch the draft in place; every question and batch edit goes through here */
const patchDraft = (fn: (d: DecisionDraft) => DecisionDraft) => {
  const cur = get().draft;
  if (cur) persist(fn(cur));
};

/* questions are addressed by position: a name can be blank or duplicated while it is
   being edited, and the editor's cards are keyed by position for the same reason */
const patchQuestion = (
  index: number,
  fn: (q: DecisionQuestion) => DecisionQuestion,
) =>
  patchDraft((d) => ({
    ...d,
    questions: d.questions.map((q, i) => (i === index ? fn(q) : q)),
  }));

const patchBatchItem = (
  index: number,
  fn: (it: DecisionBatchItem) => DecisionBatchItem,
) =>
  patchDraft((d) => ({
    ...d,
    batchItems: (d.batchItems ?? []).map((it, i) => (i === index ? fn(it) : it)),
  }));

/* one pending rename at a time; keystrokes merge into it */
let titleTimer: ReturnType<typeof setTimeout> | null = null;
let pendingTitle: { id: string; title: string } | null = null;

const saveTitle = () => {
  titleTimer = null;
  const p = pendingTitle;
  pendingTitle = null;
  if (!p) return;
  decisionsApi
    .patch(p.id, { title: p.title })
    .then((run) => set({ items: upsert(get().items, run) }))
    .catch((e: unknown) =>
      uiActions.toast(`Renaming failed — ${errorText(e)}`, 'error'),
    );
};

export const decisionsActions = {
  async loadDecisions() {
    set({ status: 'loading', error: undefined });
    try {
      setDecisionItems(await fetchDecisions(useNetworkStore.getState().dev));
      set({ status: 'ready' });
    } catch (e) {
      set({ status: 'error', error: errorText(e) });
    }
  },

  /** mints a run and opens its editor; nothing is stored until it is evaluated */
  newDecision() {
    this.openDraft({});
  },

  /** mints a batch run and opens its editor in batch mode */
  newBatchDecision() {
    this.openDraft({
      batchMode: true,
      batchItems: [
        newBatchItem('', 'ITEM-01'),
        newBatchItem('', 'ITEM-02'),
        newBatchItem('', 'ITEM-03'),
      ],
    });
  },

  /** mints a run seeded from an example template and opens its editor */
  newDecisionFromExample(example: DecisionExample) {
    this.openDraft({
      title: example.title,
      input: example.input,
      questions: example.questions,
      batchItems: exampleBatchInputs(example).map((b) =>
        newBatchItem(b.input, b.label),
      ),
    });
  },

  /** mints a batch run seeded from an example template and opens its editor in batch mode */
  newBatchDecisionFromExample(example: DecisionExample) {
    const rows = exampleBatchInputs(example);
    this.openDraft({
      title: example.title,
      input: example.input,
      questions: example.questions,
      batchMode: true,
      batchItems: rows.map((b) => newBatchItem(b.input, b.label)),
    });
  },

  openDraft(
    seed: Partial<
      Pick<
        DecisionDraft,
        'title' | 'input' | 'questions' | 'batchMode' | 'batchItems'
      >
    >,
  ) {
    const draft: DecisionDraft = {
      id: uuid(),
      modelId: defaultModelId(),
      title: seed.title ?? '',
      input: seed.input ?? '',
      questions: (seed.questions ?? [newQuestion('predicate', [])]).map(
        cloneQuestion,
      ),
      ...(seed.batchMode !== undefined ? { batchMode: seed.batchMode } : {}),
      ...(seed.batchItems ? { batchItems: seed.batchItems } : {}),
    };
    persist(draft);
    set({ runError: undefined });
    uiActions.navigateTo(`/decisions/${draft.id}`);
    return draft.id;
  },

  /** points the editor at a run: the cached draft first, then the server's copy */
  openDecision(id: string) {
    /* already on screen — a refetch must not clobber edits in progress */
    if (get().draft?.id === id) return;
    const run = get().items.find((r) => r.id === id);
    const cachedRaw = LS.get<DecisionDraft | null>('decisions.draft', null);
    const cached =
      cachedRaw && cachedRaw.id === id
        ? {
            ...cachedRaw,
            ...(cachedRaw.batchItems
              ? { batchItems: sanitizeCachedBatchItems(cachedRaw.batchItems) }
              : {}),
          }
        : null;
    const draft = cached ?? (run ? toDraft(run, cached) : null);
    set({ draft, runError: draft && run ? run.error : undefined });
  },

  setDecisionModel(modelId: string) {
    patchDraft((d) => ({ ...d, modelId }));
  },

  setDecisionInput(input: string) {
    patchDraft((d) => ({ ...d, input }));
  },

  setDecisionBatchMode(batchMode: boolean) {
    patchDraft((d) => {
      if (batchMode) {
        const existing = d.batchItems ?? [];
        if (existing.length > 0) return { ...d, batchMode: true };
        const seeded = d.input.trim()
          ? [newBatchItem(d.input, 'ITEM-01'), newBatchItem('', 'ITEM-02')]
          : [
              newBatchItem('', 'ITEM-01'),
              newBatchItem('', 'ITEM-02'),
              newBatchItem('', 'ITEM-03'),
            ];
        return { ...d, batchMode: true, batchItems: seeded };
      }
      const firstInput =
        !d.input.trim() && d.batchItems?.[0]?.input.trim()
          ? d.batchItems[0].input
          : d.input;
      return { ...d, batchMode: false, input: firstInput };
    });
  },

  addDecisionBatchItem(input = '', label?: string) {
    patchDraft((d) => {
      const cur = d.batchItems ?? [];
      if (cur.length >= MAX_DECISION_BATCH_ITEMS) return d;
      const autoLabel =
        label ?? `ITEM-${String(cur.length + 1).padStart(2, '0')}`;
      return {
        ...d,
        batchItems: [...cur, newBatchItem(input, autoLabel)],
      };
    });
  },

  updateDecisionBatchItem(
    index: number,
    patch: { input?: string; label?: string },
  ) {
    patchBatchItem(index, (it) => {
      const inputChanged =
        patch.input !== undefined && patch.input !== it.input;
      return {
        ...it,
        ...(patch.input !== undefined ? { input: patch.input } : {}),
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(inputChanged
          ? {
              status: 'idle' as const,
              answers: undefined,
              error: undefined,
              usage: undefined,
              latencyMs: undefined,
            }
          : {}),
      };
    });
  },

  removeDecisionBatchItem(index: number) {
    patchDraft((d) => {
      const cur = d.batchItems ?? [];
      if (cur.length <= 1) {
        return {
          ...d,
          batchItems: [newBatchItem('', 'ITEM-01')],
        };
      }
      return {
        ...d,
        batchItems: cur.filter((_, i) => i !== index),
      };
    });
  },

  moveDecisionBatchItem(from: number, dir: -1 | 1) {
    patchDraft((d) => {
      const cur = d.batchItems ?? [];
      const to = from + dir;
      if (to < 0 || to >= cur.length) return d;
      const next = [...cur];
      const item = next[from];
      const target = next[to];
      if (!item || !target) return d;
      next[from] = target;
      next[to] = item;
      return { ...d, batchItems: next };
    });
  },

  duplicateDecisionBatchItem(index: number) {
    patchDraft((d) => {
      const cur = d.batchItems ?? [];
      if (cur.length >= MAX_DECISION_BATCH_ITEMS) return d;
      const source = cur[index];
      if (!source) return d;
      const copy = newBatchItem(
        source.input,
        source.label ? `${source.label}-copy` : undefined,
      );
      const next = [...cur];
      next.splice(index + 1, 0, copy);
      return { ...d, batchItems: next };
    });
  },

  importDecisionBatchItems(
    rows: { label?: string; input: string }[],
    mode: 'append' | 'replace' = 'append',
  ) {
    patchDraft((d) => {
      const cur = d.batchItems ?? [];
      const nonEmptyCur =
        mode === 'replace' ? [] : cur.filter((it) => it.input.trim() !== '');
      const room = Math.max(0, MAX_DECISION_BATCH_ITEMS - nonEmptyCur.length);
      const added = rows.slice(0, room).map((r, i) =>
        newBatchItem(
          r.input.slice(0, 100_000),
          r.label ||
            `ITEM-${String(nonEmptyCur.length + i + 1).padStart(2, '0')}`,
        ),
      );
      const merged = [...nonEmptyCur, ...added];
      return {
        ...d,
        batchMode: true,
        batchItems:
          merged.length > 0 ? merged : [newBatchItem('', 'ITEM-01')],
      };
    });
  },

  loadDecisionSampleBatch() {
    patchDraft((d) => {
      const match =
        DECISION_EXAMPLES.find(
          (e) =>
            e.title.toLowerCase() === d.title.trim().toLowerCase() ||
            e.questions.every((eq) =>
              d.questions.some((dq) => dq.name === eq.name),
            ),
        ) ?? DECISION_EXAMPLES[0];
      const sample = exampleBatchInputs(match);
      return {
        ...d,
        batchMode: true,
        title: d.title.trim() || match?.title || '',
        batchItems: sample.map((b) => newBatchItem(b.input, b.label)),
      };
    });
  },

  clearDecisionBatchItems() {
    patchDraft((d) => ({
      ...d,
      batchItems: [
        newBatchItem('', 'ITEM-01'),
        newBatchItem('', 'ITEM-02'),
      ],
    }));
  },

  setDecisionTitle(title: string) {
    patchDraft((d) => ({ ...d, title }));
    const cur = get().draft;
    /* a run that was never evaluated has no row to rename yet */
    const t = title.trim();
    if (!cur || !t || !get().items.some((r) => r.id === cur.id)) return;
    pendingTitle = { id: cur.id, title: t };
    if (titleTimer) clearTimeout(titleTimer);
    titleTimer = setTimeout(saveTitle, TITLE_DELAY_MS);
  },

  /** sends a pending rename now, e.g. when leaving the editor */
  flushDecisionTitle() {
    if (!pendingTitle) return;
    if (titleTimer) clearTimeout(titleTimer);
    saveTitle();
  },

  /** writes the draft cache at once; keeps batch state or unstored drafts */
  flushDecisionDraft() {
    const d = get().draft;
    if (
      d &&
      (d.batchMode ||
        (d.batchItems?.length ?? 0) > 0 ||
        !get().items.some((r) => r.id === d.id))
    ) {
      LS.set('decisions.draft', d);
    }
  },

  addDecisionQuestion(type: DecisionQuestionType) {
    patchDraft((d) => ({
      ...d,
      questions: [...d.questions, newQuestion(type, d.questions)],
    }));
  },

  setDecisionQuestionType(index: number, type: DecisionQuestionType) {
    patchQuestion(index, (q) => {
      if (q.type === type) return q;
      if (type === 'choice') {
        const seeded =
          q.choices && q.choices.length > 0
            ? q.choices
            : q.levels && q.levels.length > 0
              ? q.levels.map((l) => ({
                  value: l.label,
                  ...(l.description ? { description: l.description } : {}),
                }))
              : ([{ value: '' }, { value: '' }] as DecisionQuestion['choices']);
        return {
          name: q.name,
          type,
          instructions: q.instructions,
          choices: seeded,
        };
      }
      if (type === 'score') {
        const seeded =
          q.levels && q.levels.length > 0
            ? q.levels
            : q.choices && q.choices.length > 0
              ? q.choices.slice(0, MAX_DECISION_LEVELS).map((c) => ({
                  label: c.value,
                  ...(c.description ? { description: c.description } : {}),
                }))
              : ([{ label: '' }, { label: '' }] as DecisionQuestion['levels']);
        return {
          name: q.name,
          type,
          instructions: q.instructions,
          levels: seeded,
        };
      }
      return {
        name: q.name,
        type,
        instructions: q.instructions,
        ...(q.criteria ? { criteria: q.criteria } : {}),
      };
    });
  },

  moveDecisionQuestionEntry(index: number, from: number, dir: -1 | 1) {
    patchQuestion(index, (q) => {
      const to = from + dir;
      if (q.type === 'choice' && q.choices) {
        if (to < 0 || to >= q.choices.length) return q;
        const next = [...q.choices];
        const item = next[from];
        const target = next[to];
        if (!item || !target) return q;
        next[from] = target;
        next[to] = item;
        return { ...q, choices: next };
      }
      if (q.type === 'score' && q.levels) {
        if (to < 0 || to >= q.levels.length) return q;
        const next = [...q.levels];
        const item = next[from];
        const target = next[to];
        if (!item || !target) return q;
        next[from] = target;
        next[to] = item;
        return { ...q, levels: next };
      }
      return q;
    });
  },

  resetDecisionDraft() {
    const cur = get().draft;
    if (!cur) return;
    const run = get().items.find((r) => r.id === cur.id);
    if (run && !cur.batchMode) {
      LS.del('decisions.draft');
      set({ draft: toDraft(run), runError: run.error });
      return;
    }
    persist({
      id: cur.id,
      modelId: cur.modelId || defaultModelId(),
      title: '',
      input: '',
      questions: [newQuestion('predicate', [])],
      ...(cur.batchMode
        ? {
            batchMode: true,
            batchItems: [
              newBatchItem('', 'ITEM-01'),
              newBatchItem('', 'ITEM-02'),
              newBatchItem('', 'ITEM-03'),
            ],
          }
        : {}),
    });
    set({ runError: undefined });
  },

  renameDecisionQuestion(index: number, name: string) {
    patchQuestion(index, (q) => ({ ...q, name }));
  },

  updateDecisionQuestion(
    index: number,
    patch: Partial<Omit<DecisionQuestion, 'name' | 'type'>>,
  ) {
    patchQuestion(index, (q) => ({ ...q, ...patch }));
  },

  removeDecisionQuestion(index: number) {
    patchDraft((d) => ({
      ...d,
      questions: d.questions.filter((_, i) => i !== index),
    }));
  },

  /** aborts an active batch run, leaving already-completed rows intact */
  stopDecisionBatch() {
    if (batchAbort) {
      batchAbort.abort();
      batchAbort = null;
    }
    patchDraft((d) => ({
      ...d,
      ...(d.batchItems
        ? {
            batchItems: d.batchItems.map((it) =>
              it.status === 'running' || it.status === 'queued'
                ? { ...it, status: 'idle' as const }
                : it,
            ),
          }
        : {}),
    }));
    set({ running: false });
    uiActions.toast('Batch evaluation stopped', 'info');
  },

  /** evaluates batch rows concurrently against the stateless /api/decisions endpoint */
  async runDecisionBatch(opts?: {
    onlyIndices?: number[];
    concurrency?: number;
  }): Promise<boolean> {
    const draft = get().draft;
    if (!draft || get().running) return false;
    const problems = decisionProblems(draft);
    if (problems.length > 0) {
      uiActions.toast(
        problems[0] ?? 'This batch isn’t ready to run',
        'warn',
      );
      return false;
    }

    const items = draft.batchItems ?? [];
    const targetIndices = (
      opts?.onlyIndices ?? items.map((_, idx) => idx)
    ).filter((idx) => (items[idx]?.input.trim() ?? '') !== '');

    if (targetIndices.length === 0) {
      uiActions.toast('Add at least one non-empty batch input', 'warn');
      return false;
    }

    const targetSet = new Set(targetIndices);
    const controller = new AbortController();
    batchAbort = controller;

    set({ running: true, runError: undefined });
    patchDraft((d) => ({
      ...d,
      batchItems: (d.batchItems ?? []).map((it, idx) =>
        targetSet.has(idx)
          ? { ...it, status: 'queued' as const, error: undefined }
          : it,
      ),
    }));

    const modelId = draft.modelId;
    const title = draft.title.trim();
    const questions = draft.questions.map(cloneQuestion);
    const concurrency = Math.max(
      1,
      Math.min(opts?.concurrency ?? DEFAULT_BATCH_CONCURRENCY, targetIndices.length),
    );

    let cursor = 0;
    let successCount = 0;
    let failCount = 0;
    let firstError: string | undefined;

    const worker = async () => {
      while (cursor < targetIndices.length && !controller.signal.aborted) {
        const idx = targetIndices[cursor++];
        if (idx === undefined) break;
        const rowItem = get().draft?.batchItems?.[idx];
        if (!rowItem || !rowItem.input.trim()) continue;
        const itemId = rowItem.id;

        patchDraft((d) => ({
          ...d,
          batchItems: (d.batchItems ?? []).map((it) =>
            it.id === itemId
              ? { ...it, status: 'running' as const, error: undefined }
              : it,
          ),
        }));

        try {
          const res = await decisionsApi.evaluate(
            {
              modelId,
              ...(title ? { title } : {}),
              input: rowItem.input,
              questions,
              stateless: true,
            },
            controller.signal,
          );
          if (controller.signal.aborted) break;
          if (res.error) {
            failCount++;
            if (!firstError) firstError = res.error;
            patchDraft((d) => ({
              ...d,
              batchItems: (d.batchItems ?? []).map((it) =>
                it.id === itemId
                  ? {
                      ...it,
                      status: 'error' as const,
                      error: res.error,
                      answers: undefined,
                      evaluatedAt: Date.now(),
                    }
                  : it,
              ),
            }));
          } else {
            successCount++;
            patchDraft((d) => ({
              ...d,
              batchItems: (d.batchItems ?? []).map((it) =>
                it.id === itemId
                  ? {
                      ...it,
                      status: 'done' as const,
                      answers: res.answers,
                      usage: res.usage,
                      latencyMs: res.latencyMs,
                      error: undefined,
                      evaluatedAt: Date.now(),
                    }
                  : it,
              ),
            }));
          }
        } catch (e) {
          if (controller.signal.aborted) break;
          const msg = errorText(e);
          failCount++;
          if (!firstError) firstError = msg;
          patchDraft((d) => ({
            ...d,
            batchItems: (d.batchItems ?? []).map((it) =>
              it.id === itemId
                ? {
                    ...it,
                    status: 'error' as const,
                    error: msg,
                    evaluatedAt: Date.now(),
                  }
                : it,
            ),
          }));
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (batchAbort === controller) {
      batchAbort = null;
    }

    if (controller.signal.aborted) {
      return successCount > 0;
    }

    if (successCount > 0) {
      LS.set('decisions.lastModel', modelId);
    }

    set({
      running: false,
      runError:
        successCount === 0 && firstError ? firstError : undefined,
    });

    if (failCount > 0 && successCount > 0) {
      uiActions.toast(
        `Batch finished: ${successCount} succeeded, ${failCount} failed`,
        'warn',
      );
    } else if (failCount > 0 && successCount === 0) {
      uiActions.toast(
        `Batch failed — ${firstError ?? 'Unknown error'}`,
        'error',
      );
    }

    return successCount > 0;
  },

  /** stores the run and evaluates it (or runs the batch when in batch mode) */
  async runDecision(): Promise<boolean> {
    const draft = get().draft;
    if (!draft || get().running) return false;
    if (draft.batchMode) {
      return this.runDecisionBatch();
    }
    const problems = decisionProblems(draft);
    if (problems.length > 0) {
      uiActions.toast(
        problems[0] ?? 'This decision isn’t ready to run',
        'warn',
      );
      return false;
    }
    set({ running: true, runError: undefined });
    const title = draft.title.trim();
    try {
      const run = await decisionsApi.evaluate({
        id: draft.id,
        modelId: draft.modelId,
        ...(title ? { title } : {}),
        input: draft.input,
        questions: draft.questions,
      });
      LS.set('decisions.lastModel', draft.modelId);
      /* the row is the source of truth from here on */
      if (!draft.batchItems?.length) {
        LS.del('decisions.draft');
      }
      set({
        items: upsert(get().items, run),
        draft: toDraft(run, draft),
        running: false,
        status: 'ready',
        ...(run.error ? { runError: run.error } : { runError: undefined }),
      });
      if (run.error) {
        uiActions.toast(`Decision failed — ${run.error}`, 'error');
        return false;
      }
      return true;
    } catch (e) {
      set({ running: false, runError: errorText(e) });
      uiActions.toast(`Decision failed — ${errorText(e)}`, 'error');
      return false;
    }
  },

  async deleteDecision(id: string) {
    if (batchAbort) {
      batchAbort.abort();
      batchAbort = null;
    }
    const prev = get().items;
    /* a draft that was never run has no row: discarding it is local only */
    const stored = prev.some((r) => r.id === id);
    /* a rename queued for this run must not fire once the row is gone */
    if (pendingTitle?.id === id) {
      if (titleTimer) clearTimeout(titleTimer);
      titleTimer = null;
      pendingTitle = null;
    }
    set({ items: prev.filter((r) => r.id !== id) });
    if (get().draft?.id === id) {
      LS.del('decisions.draft');
      set({ draft: null, runError: undefined, running: false });
    }
    if (!stored) return;
    try {
      await decisionsApi.remove(id);
    } catch (e) {
      set({ items: prev });
      uiActions.toast(`Delete failed — ${errorText(e)}`, 'error');
    }
  },
};

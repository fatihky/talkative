/*
 * DecisionsStore — the /decisions screens: the run list, the editor's draft
 * and the evaluation itself.
 *
 * Business logic:
 * - runs are server-owned and, like memories, deliberately not cached in
 *   localStorage nor loaded at boot: the screens refetch on mount, so a deep
 *   link never shows somebody's stale answers. The list is sorted by
 *   updatedAt desc, which floats a re-run to the top.
 * - the editor works on a DecisionDraft (lib/decisions.ts) that is mirrored
 *   to localStorage 'decisions.draft' as it is typed, so a reload keeps an
 *   unevaluated run; evaluating clears it, because from then on the row is
 *   the source of truth. Leaving the editor flushes that mirror at once —
 *   but only while the run is still unstored — so the last keystrokes aren't
 *   lost to the 400ms debounce.
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
 *   runError. Either way the returned run replaces the draft and the list
 *   entry, so the answers on screen are the ones the server stored.
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
  type DecisionDraft,
  type DecisionExample,
  decisionProblems,
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
  /* true between the POST and its answer */
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

/* a draft never shares structure with the stored run it came from */
const cloneQuestion = (q: DecisionQuestion): DecisionQuestion => ({
  ...q,
  ...(q.criteria ? { criteria: { ...q.criteria } } : {}),
  ...(q.choices ? { choices: q.choices.map((c) => ({ ...c })) } : {}),
  ...(q.levels ? { levels: q.levels.map((l) => ({ ...l })) } : {}),
});

const toDraft = (r: DecisionRun): DecisionDraft => ({
  id: r.id,
  modelId: r.modelId,
  title: r.title,
  input: r.input,
  questions: r.questions.map(cloneQuestion),
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
  if (last && items.some((m) => m.id === last)) return last;
  return items.find(isDecisionCapable)?.id ?? '';
};

const persist = (draft: DecisionDraft) => {
  set({ draft });
  debouncedSet('decisions.draft', draft);
};

/* patch the draft in place; every question edit goes through here */
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

  /** mints a run seeded from an example template and opens its editor */
  newDecisionFromExample(example: DecisionExample) {
    this.openDraft(example);
  },

  openDraft(
    seed: Partial<Pick<DecisionDraft, 'title' | 'input' | 'questions'>>,
  ) {
    const draft: DecisionDraft = {
      id: uuid(),
      modelId: defaultModelId(),
      title: seed.title ?? '',
      input: seed.input ?? '',
      questions: (seed.questions ?? [newQuestion('predicate', [])]).map(
        cloneQuestion,
      ),
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
    const cached = LS.get<DecisionDraft | null>('decisions.draft', null);
    const draft =
      cached && cached.id === id ? cached : run ? toDraft(run) : null;
    set({ draft, runError: draft && run ? run.error : undefined });
  },

  setDecisionModel(modelId: string) {
    patchDraft((d) => ({ ...d, modelId }));
  },

  setDecisionInput(input: string) {
    patchDraft((d) => ({ ...d, input }));
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

  /** writes the draft cache at once; only a run that never reached the server needs it */
  flushDecisionDraft() {
    const d = get().draft;
    if (d && !get().items.some((r) => r.id === d.id))
      LS.set('decisions.draft', d);
  },

  addDecisionQuestion(type: DecisionQuestionType) {
    patchDraft((d) => ({
      ...d,
      questions: [...d.questions, newQuestion(type, d.questions)],
    }));
  },

  setDecisionQuestionType(index: number, type: DecisionQuestionType) {
    patchQuestion(index, (q) => ({
      ...q,
      type,
      /* switching type seeds what the new shape requires, and drops what it can't use */
      ...(type === 'choice'
        ? {
            choices:
              q.choices && q.choices.length > 0
                ? q.choices
                : ([
                    { value: '' },
                    { value: '' },
                  ] as DecisionQuestion['choices']),
            levels: undefined,
          }
        : type === 'score'
          ? {
              levels:
                q.levels && q.levels.length > 0
                  ? q.levels
                  : ([
                      { label: '' },
                      { label: '' },
                    ] as DecisionQuestion['levels']),
              choices: undefined,
            }
          : { choices: undefined, levels: undefined }),
    }));
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

  /** stores the run and evaluates it; failures land in runError rather than throwing */
  async runDecision() {
    const draft = get().draft;
    if (!draft || get().running) return;
    const problems = decisionProblems(draft);
    if (problems.length > 0) {
      set({ runError: problems[0] });
      uiActions.toast(
        problems[0] ?? 'This decision isn’t ready to run',
        'warn',
      );
      return;
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
      LS.del('decisions.draft');
      set({
        items: upsert(get().items, run),
        draft: toDraft(run),
        running: false,
        status: 'ready',
        ...(run.error ? { runError: run.error } : { runError: undefined }),
      });
      if (run.error) uiActions.toast(`Decision failed — ${run.error}`, 'error');
    } catch (e) {
      set({ running: false, runError: errorText(e) });
      uiActions.toast(`Decision failed — ${errorText(e)}`, 'error');
    }
  },

  async deleteDecision(id: string) {
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
      set({ draft: null, runError: undefined });
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

/*
 * useMemoriesStore / memoriesActions — the user's durable memories: the
 * key/value notes the memory tool writes and every chat can read.
 *
 * Business logic:
 * - deliberately not cached in localStorage and not loaded at boot: the
 *   model writes memories mid-run, so the settings screens refetch on
 *   mount (and on their reload button) instead of trusting stale rows.
 * - server-first, never optimistic: each mutation awaits the API and then
 *   applies the row the server returned, so a refused write leaves the
 *   list exactly as it was.
 * - create and update re-sort by updatedAt desc, putting a touched memory
 *   on top and matching GET /api/memories' order; delete filters its row
 *   out and clearMemories empties the list.
 * - the mutations throw on validation/network errors so MemoryForm can
 *   show the message inline, while loadMemories catches into
 *   status/error for the list page.
 * - status drives the UI: rows render only once 'ready' (with an empty
 *   state at zero), 'error' prints its message above the list, the reload
 *   button is disabled while loading, and the settings nav shows the
 *   memory count only when ready.
 */
'use client';

import { create } from 'zustand';
import { memoriesApi } from '../lib/api';
import { uid } from '../lib/storage';
import type { Memory } from '../types';
import { draftActions } from './draft';
import { errorText } from './models';

type MemoriesState = {
  items: Memory[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string | undefined;
};

export const useMemoriesStore = create<MemoriesState>()(() => ({
  items: [],
  status: 'idle',
}));

const set = useMemoriesStore.setState;
const get = useMemoriesStore.getState;

/* newest edit first, matching GET /api/memories */
const sorted = (items: Memory[]) =>
  [...items].sort((a, b) => b.updatedAt - a.updatedAt);

export const memoriesActions = {
  /* not cached locally: the model writes memories mid-run, so always refetch */
  async loadMemories() {
    set({ status: 'loading', error: undefined });
    try {
      set({ items: await memoriesApi.list(), status: 'ready' });
    } catch (e) {
      set({ status: 'error', error: errorText(e) });
    }
  },

  /** throws on validation/network errors so forms can show them inline */
  async createMemory(input: { key: string; value: string }) {
    const created = await memoriesApi.create(input);
    set({ items: sorted([created, ...get().items]) });
  },

  async updateMemory(id: string, patch: { key?: string; value?: string }) {
    const updated = await memoriesApi.patch(id, patch);
    set({
      items: sorted(get().items.map((m) => (m.id === id ? updated : m))),
    });
  },

  async deleteMemory(id: string) {
    await memoriesApi.remove(id);
    set({ items: get().items.filter((m) => m.id !== id) });
  },

  async clearMemories() {
    await memoriesApi.clear();
    set({ items: [] });
  },

  /** stages a memory as a `memory:` attachment carrying the row id, inlined on send */
  attachMemory(id: string) {
    const m = get().items.find((x) => x.id === id);
    if (!m) return;
    draftActions.addAttachments([
      { id: uid(), kind: 'memory', name: `memory: ${m.key}`, memoryId: m.id },
    ]);
  },
};

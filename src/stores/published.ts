/*
 * PublishedStore — the user's public artifact links (/a/<id>).
 *
 * Business logic:
 * - server-derived and never cached: loadPublished replaces items from
 *   GET /api/artifacts, run on mount by the artifacts settings page and
 *   lazily by the panel's share popover whenever status is still 'idle'.
 * - publish upserts — an existing row for that artifact id is replaced
 *   (re-publishing keeps the same public link), a new one is prepended,
 *   and the list is re-sorted newest-first to match the api.
 * - setPublished flips a link public or private and remove deletes it for
 *   good; both run after the server answered and only then touch items,
 *   so a rejected call leaves the list untouched — callers confirm first
 *   and toast the error themselves.
 * - status and error back the settings page's loading and error rows, and
 *   its reload button simply calls loadPublished again.
 * - rows carry artifactId, version and content, which the share popover
 *   compares against the version on screen to offer "update the public
 *   link" once the artifact has moved on.
 */
'use client';

import { create } from 'zustand';
import { artifactsApi } from '../lib/api';
import type { PublicArtifact } from '../types';
import { errorText } from './models';

type PublishedState = {
  items: PublicArtifact[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string | undefined;
};

export const usePublishedStore = create<PublishedState>()(() => ({
  items: [],
  status: 'idle',
}));

const set = usePublishedStore.setState;
const get = usePublishedStore.getState;

/* newest first, matching GET /api/artifacts */
const sorted = (items: PublicArtifact[]) =>
  [...items].sort((a, b) => b.createdAt - a.createdAt);

export const publishedActions = {
  async loadPublished() {
    set({ status: 'loading', error: undefined });
    try {
      set({ items: await artifactsApi.list(), status: 'ready' });
    } catch (e) {
      set({ status: 'error', error: errorText(e) });
    }
  },

  /** publish (or re-publish) the current version of an artifact; returns the row */
  async publish(input: Parameters<typeof artifactsApi.publish>[0]) {
    const saved = await artifactsApi.publish(input);
    const existing = get().items.find((a) => a.id === saved.id);
    set({
      items: sorted(
        existing
          ? get().items.map((a) => (a.id === saved.id ? saved : a))
          : [saved, ...get().items],
      ),
      status: 'ready',
    });
    return saved;
  },

  async setPublished(id: number, published: boolean) {
    const updated = await artifactsApi.setPublished(id, published);
    set({ items: get().items.map((a) => (a.id === id ? updated : a)) });
  },

  async remove(id: number) {
    await artifactsApi.remove(id);
    set({ items: get().items.filter((a) => a.id !== id) });
  },
};

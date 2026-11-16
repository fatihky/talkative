/*
 * ModelOverrides — the /settings/providers model list, now editable.
 *
 * Business logic:
 * - The list is what GET /api/model-overrides answers: every model
 *   from the enabled providers with the user's overrides applied, plus
 *   the custom models they added. Saving or resetting doesn't refetch:
 *   the write answers with that id's merged entry, which is patched into
 *   the lists and mirrored into the models store (and its cache), so the
 *   composer, decisions and this page agree at once.
 * - Hidden models are not in the payload by design; `hidden` holds
 *   their ids so the filter chips can still offer them and reveal an
 *   "Unhide" row instead of losing the entry entirely.
 * - Loading refreshes the catalog only on the page's first fetch
 *   (`refresh`), like /api/providers' catalogs: the rest ride the
 *   server's ten-minute cache.
 * - Errors surface next to the header; a failed save leaves the dialog
 *   open so the edit isn't lost.
 * - The provider filter is the component's: it narrows the loaded list,
 *   so picking a provider never refetches. Hidden entries carry their
 *   provider name for it.
 */
'use client';

import { create } from 'zustand';
import {
  type ModelOverrideBody,
  type ModelOverrideResult,
  type ModelOverridesResponse,
  modelOverridesApi,
  fetchModelOverrides,
} from '../lib/api';
import type { Model } from '../types';
import {
  applyModels,
  byName,
  errorText,
  useModelsStore,
} from './models';
import { uiActions } from './ui';

export type OverrideConnection = { id: number; name: string };

type ModelOverridesState = {
  items: Model[];
  /* models the server left out because the user hid them */
  hidden: ModelOverridesResponse['hidden'];
  /* rows no list can show (their connection is gone or disabled) */
  orphans: ModelOverridesResponse['orphans'];
  connections: OverrideConnection[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string | undefined;
  saving: boolean;
};

export const useModelOverridesStore = create<ModelOverridesState>()(() => ({
  items: [],
  hidden: [],
  orphans: [],
  connections: [],
  status: 'idle',
  saving: false,
}));

const set = useModelOverridesStore.setState;

/* bumped per fetch and per write: only the newest may land, so the page's
   slow first load (refresh) can't overwrite a save that happened meanwhile */
let seq = 0;

const load = (refresh: boolean) => {
  const mine = ++seq;
  set({ status: 'loading' });
  return fetchModelOverrides({ refresh })
    .then((r) => {
      if (mine !== seq) return r;
      set({
        items: r.items.toSorted(byName),
        hidden: r.hidden,
        orphans: r.orphans,
        connections: r.connections,
        status: 'ready',
        error: undefined,
      });
      /* one catalog for every screen: the composer reads the models store */
      applyModels(r);
      return r;
    })
    .catch((e: unknown) => {
      if (mine === seq) set({ status: 'error', error: errorText(e) });
      throw e;
    });
};

/* folds one id's write result into the lists and the models store, so
   nothing is refetched: the server already answered with the merged model */
const applyResult = (id: string, r: ModelOverrideResult) => {
  seq++;
  const cur = useModelOverridesStore.getState();
  const items = r.model
    ? [...cur.items.filter((m) => m.id !== id), r.model].toSorted(byName)
    : cur.items.filter((m) => m.id !== id);
  const hidden = cur.hidden.filter((h) => h.id !== id);
  /* an orphan has no connection name, so it can't be listed as hidden: it
     stays an orphan, with the row as now stored, or leaves when deleted */
  const provider = cur.connections.find(
    (c) => c.id === r.override?.connectionId,
  )?.name;
  if (r.override?.hidden === true && provider) {
    hidden.push({ id, provider, override: r.override });
  }
  const orphans = cur.orphans.filter((o) => o.id !== id);
  if (!r.model && r.override && !provider) {
    orphans.push({ id, override: r.override });
  }
  set({ items, hidden, orphans, status: 'ready', error: undefined });
  const models = useModelsStore.getState();
  applyModels({
    items,
    syncedAt: models.lastSyncedAt ?? Date.now(),
    errors: models.errors,
  });
};

export const modelOverridesActions = {
  /* the page's first load: let the server refresh stale provider lists */
  load(refresh = false) {
    return load(refresh).catch(() => undefined);
  },

  /* PUT one model's overrides; a body that clears everything resets it */
  async save(id: string, override: ModelOverrideBody) {
    set({ saving: true });
    try {
      applyResult(id, await modelOverridesApi.save(id, override));
    } finally {
      set({ saving: false });
    }
    /* a body the server drops as empty (only `hidden: false`) reads as a reset */
    const cleared =
      !override.hidden &&
      Object.entries(override).every(
        ([k, v]) => k === 'hidden' || v === undefined || v === null,
      );
    uiActions.toast(cleared ? 'Model override reset' : 'Model override saved');
  },

  async reset(id: string) {
    set({ saving: true });
    try {
      applyResult(id, await modelOverridesApi.remove(id));
    } finally {
      set({ saving: false });
    }
    uiActions.toast('Model override reset');
  },
};

/*
 * ModelOverrides — the /settings/providers model list, now editable.
 *
 * Business logic:
 * - The list is what GET /api/model-overrides answers: every model
 *   from the enabled providers with the user's overrides applied, plus
 *   the custom models they added. Saving or resetting re-reads that
 *   endpoint and mirrors the result into the models store (and its
 *   cache), so the composer, decisions and this page agree at once.
 * - Hidden models are not in the payload by design; `hidden` holds
 *   their ids so the filter chips can still offer them and reveal an
 *   "Unhide" row instead of losing the entry entirely.
 * - Loading refreshes the catalog only on the page's first fetch
 *   (`refresh`), like /api/providers' catalogs: the rest ride the
 *   server's ten-minute cache.
 * - Errors surface next to the header; a failed save leaves the dialog
 *   open so the edit isn't lost.
 * - A provider filter (?provider=<name>) is applied by the server, not
 *   in the component: only that provider's connections are fetched and
 *   only their hidden ids come back. `items` is therefore the filtered
 *   view; the unfiltered one is fetched again when the filter clears.
 */
'use client';

import { create } from 'zustand';
import {
  fetchModelOverrides,
  type ModelOverrideBody,
  modelOverridesApi,
} from '../lib/api';
import type { Model } from '../types';
import { applyModels, errorText } from './models';

export type OverrideConnection = { id: number; name: string };

type ModelOverridesState = {
  items: Model[];
  /* ids the server left out because the user hid them */
  hidden: string[];
  connections: OverrideConnection[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string | undefined;
  saving: boolean;
  /* the connection name the last load was narrowed to; '' = every provider */
  provider: string;
};

export const useModelOverridesStore = create<ModelOverridesState>()(() => ({
  items: [],
  hidden: [],
  connections: [],
  status: 'idle',
  saving: false,
  provider: '',
}));

const set = useModelOverridesStore.setState;

const load = (refresh: boolean) => {
  const provider = useModelOverridesStore.getState().provider;
  set({ status: 'loading' });
  return fetchModelOverrides({ refresh, provider })
    .then((r) => {
      set({
        items: r.items.toSorted(
          (a, b) =>
            a.shortName.localeCompare(b.shortName, undefined, {
              sensitivity: 'base',
              numeric: true,
            }) || a.id.localeCompare(b.id),
        ),
        hidden: r.hidden,
        connections: r.connections,
        status: 'ready',
        error: undefined,
      });
      /* one catalog for every screen: the composer reads the models store.
         a narrowed list must not become the composer's catalog. */
      if (!provider) applyModels(r);
      return r;
    })
    .catch((e: unknown) => {
      set({ status: 'error', error: errorText(e) });
      throw e;
    });
};

export const modelOverridesActions = {
  /* the page's first load: let the server refresh stale provider lists */
  load(refresh = false) {
    return load(refresh).catch(() => undefined);
  },

  /* narrow the list to one provider ('' = all); refetches when it changes */
  setProvider(provider: string) {
    if (useModelOverridesStore.getState().provider === provider) return;
    set({ provider });
    return load(false).catch(() => undefined);
  },

  /* PUT one model's overrides; a body that clears everything resets it */
  async save(id: string, override: ModelOverrideBody) {
    set({ saving: true });
    try {
      await modelOverridesApi.save(id, override);
      await load(false);
    } finally {
      set({ saving: false });
    }
  },

  async reset(id: string) {
    set({ saving: true });
    try {
      await modelOverridesApi.remove(id);
      await load(false);
    } finally {
      set({ saving: false });
    }
  },
};

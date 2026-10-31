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
 * - The provider filter is the component's: it narrows the loaded list,
 *   so picking a provider never refetches. Hidden entries carry their
 *   provider name for it.
 */
'use client';

import { create } from 'zustand';
import {
  fetchModelOverrides,
  type ModelOverrideBody,
  type ModelOverridesResponse,
  modelOverridesApi,
} from '../lib/api';
import type { Model } from '../types';
import { applyModels, errorText } from './models';
import { uiActions } from './ui';

export type OverrideConnection = { id: number; name: string };

type ModelOverridesState = {
  items: Model[];
  /* models the server left out because the user hid them */
  hidden: ModelOverridesResponse['hidden'];
  connections: OverrideConnection[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string | undefined;
  saving: boolean;
};

export const useModelOverridesStore = create<ModelOverridesState>()(() => ({
  items: [],
  hidden: [],
  connections: [],
  status: 'idle',
  saving: false,
}));

const set = useModelOverridesStore.setState;

/* bumped per fetch: only the newest one may land, so the page's slow first
   load (refresh) can't overwrite the reload that follows a save */
let seq = 0;

const load = (refresh: boolean) => {
  const mine = ++seq;
  set({ status: 'loading' });
  return fetchModelOverrides({ refresh })
    .then((r) => {
      if (mine !== seq) return r;
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
      /* one catalog for every screen: the composer reads the models store */
      applyModels(r);
      return r;
    })
    .catch((e: unknown) => {
      if (mine === seq) set({ status: 'error', error: errorText(e) });
      throw e;
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
      await modelOverridesApi.save(id, override);
      await load(false);
    } finally {
      set({ saving: false });
    }
    /* a reset body drops the row server-side, so the two say different things */
    const cleared = Object.keys(override).length === 0;
    uiActions.toast(cleared ? 'Model override reset' : 'Model override saved');
  },

  async reset(id: string) {
    set({ saving: true });
    try {
      await modelOverridesApi.remove(id);
      await load(false);
    } finally {
      set({ saving: false });
    }
    uiActions.toast('Model override reset');
  },
};

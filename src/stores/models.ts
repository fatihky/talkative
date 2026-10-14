/*
 * ModelsStore — the merged model catalog every model picker reads.
 *
 * Business logic:
 * - items come from GET /api/models, applied by boot() through
 *   applyModels(); they are sorted by shortName (case-insensitive and
 *   numeric-aware, so gpt-4 sorts before gpt-10) then by id, which is
 *   the order the picker shows.
 * - applyModels is the only writer that persists: it mirrors items to
 *   localStorage 'cache.models' and the sync time to 'cache.modelsAt',
 *   which boot() seeds the store from (stale-while-revalidate) so the
 *   composer has models before the network answers.
 * - status runs idle → loading → ready/error; 'error' leaves the cached
 *   items in place and drives the "model catalog unavailable — using
 *   cached data (age)" banner, whose retry calls retryCatalog().
 * - errors maps provider connection id → upstream message. one provider
 *   can fail (bad key, unreachable, undecryptable stored key) while the
 *   merged catalog is still 'ready', so banners report it separately.
 * - retryCatalog() re-reads the dev flags and mirrors the outcome into
 *   network.lastError; providers.ts calls it after every create, update,
 *   enable, delete and manual refresh so the merged catalog follows the
 *   connection list.
 * - with no provider configured the api returns the demo catalog, so
 *   items is never empty on a fresh install.
 * - errorText() lives here and is reused by the other stores and the
 *   settings screens for consistent failure wording.
 */
'use client';

import { create } from 'zustand';
import { fetchModels } from '../lib/api';
import { LS } from '../lib/storage';
import type { Model } from '../types';
import { useNetworkStore } from './network';

type ModelsState = {
  items: Model[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  lastSyncedAt: number | null;
  error?: string | undefined;
  /* connection id → upstream error, from GET /api/models */
  errors: Record<string, string>;
};

export const useModelsStore = create<ModelsState>()(() => ({
  items: [],
  status: 'idle',
  lastSyncedAt: null,
  errors: {},
}));

export const errorText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/* alphabetical by display name, case-insensitive and numeric-aware (gpt-4 < gpt-10) */
const byName = (a: Model, b: Model) =>
  a.shortName.localeCompare(b.shortName, undefined, {
    sensitivity: 'base',
    numeric: true,
  }) || a.id.localeCompare(b.id);

export const applyModels = (m: {
  items: Model[];
  syncedAt: number;
  errors?: Record<string, string> | undefined;
}) => {
  const items = m.items.toSorted(byName);
  useModelsStore.setState({
    items,
    status: 'ready',
    lastSyncedAt: m.syncedAt,
    error: undefined,
    errors: m.errors ?? {},
  });
  LS.set('cache.models', items);
  LS.set('cache.modelsAt', m.syncedAt);
};

export const setModelErrors = (errors: Record<string, string>) =>
  useModelsStore.setState({ errors });

export const failModels = (error: string) => {
  useModelsStore.setState({ status: 'error', error });
};

export const modelsActions = {
  retryCatalog() {
    useModelsStore.setState({ status: 'loading' });
    fetchModels(useNetworkStore.getState().dev)
      .then((m) => {
        applyModels(m);
        useNetworkStore.setState({ lastError: null });
      })
      .catch((e: unknown) => {
        failModels(errorText(e));
        useNetworkStore.setState({ lastError: errorText(e) });
      });
  },
};

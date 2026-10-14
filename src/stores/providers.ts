/*
 * ProvidersStore — the provider connections behind /settings/providers
 * and a per-connection summary of each one's model catalog.
 *
 * Business logic:
 * - items are connection DTOs: name, baseUrl, compatibility, enabled and
 *   hasApiKey only — the key itself never reaches the client, so a form
 *   sends undefined to keep the stored key and null to clear it.
 * - loadProviders lists connections, then loads the catalogs of the
 *   enabled ones in parallel; a disabled or unreachable provider stays
 *   quiet instead of failing the page, and its reason lands in that
 *   connection's catalog entry.
 * - catalogs holds status/count/syncedAt/error per connection id, not the
 *   models themselves — the merged list lives in ModelsStore; the
 *   previous count is kept while reloading so a row doesn't flash 0.
 * - every mutation awaits the server first and only then patches items in
 *   place, so there is no optimistic state to roll back; create and
 *   update rethrow so the settings form can show validation errors
 *   inline.
 * - create, update, enable/disable, delete and manual refresh all end
 *   with modelsActions.retryCatalog(), because the composer's model list
 *   is merged from the enabled connections.
 * - enabling a connection loads its catalog (refresh=1 after a create or
 *   update, cached otherwise), disabling doesn't query it, and deleting
 *   drops its catalog entry from the map.
 */
'use client';

import { create } from 'zustand';
import { providersApi } from '../lib/api';
import type { ProviderConnection, ProviderConnectionInput } from '../types';
import { errorText, modelsActions } from './models';

export type ProviderCatalog = {
  status: 'loading' | 'ready' | 'error';
  count: number;
  syncedAt?: number | undefined;
  error?: string | undefined;
};

type ProvidersState = {
  items: ProviderConnection[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string | undefined;
  /* per-connection model list summary, keyed by connection id */
  catalogs: Record<number, ProviderCatalog>;
};

export const useProvidersStore = create<ProvidersState>()(() => ({
  items: [],
  status: 'idle',
  catalogs: {},
}));

const setCatalog = (id: number, c: ProviderCatalog) =>
  useProvidersStore.setState((s) => ({ catalogs: { ...s.catalogs, [id]: c } }));

const loadCatalog = async (id: number, refresh = false) => {
  const prev = useProvidersStore.getState().catalogs[id];
  setCatalog(id, { count: prev?.count ?? 0, status: 'loading' });
  try {
    const r = await providersApi.models(id, refresh);
    setCatalog(id, {
      status: r.error ? 'error' : 'ready',
      count: r.items.length,
      syncedAt: r.syncedAt,
      error: r.error,
    });
  } catch (e) {
    setCatalog(id, { status: 'error', count: 0, error: errorText(e) });
  }
};

export const providersActions = {
  async loadProviders() {
    useProvidersStore.setState({ status: 'loading', error: undefined });
    try {
      const items = await providersApi.list();
      useProvidersStore.setState({ items, status: 'ready' });
      /* disabled providers aren't queried, so an unreachable one stays quiet */
      await Promise.all(
        items.filter((p) => p.enabled).map((p) => loadCatalog(p.id)),
      );
    } catch (e) {
      useProvidersStore.setState({ status: 'error', error: errorText(e) });
    }
  },

  /** throws on validation/network errors so forms can show them inline */
  async createProvider(input: ProviderConnectionInput) {
    const created = await providersApi.create(input);
    useProvidersStore.setState((s) => ({ items: [...s.items, created] }));
    await loadCatalog(created.id, true);
    modelsActions.retryCatalog();
    return created;
  },

  async updateProvider(id: number, input: ProviderConnectionInput) {
    const updated = await providersApi.update(id, input);
    useProvidersStore.setState((s) => ({
      items: s.items.map((p) => (p.id === id ? updated : p)),
    }));
    await loadCatalog(id, true);
    modelsActions.retryCatalog();
    return updated;
  },

  async setProviderEnabled(id: number, enabled: boolean) {
    const updated = await providersApi.setEnabled(id, enabled);
    useProvidersStore.setState((s) => ({
      items: s.items.map((p) => (p.id === id ? updated : p)),
    }));
    if (enabled) await loadCatalog(id);
    modelsActions.retryCatalog();
  },

  async deleteProvider(id: number) {
    await providersApi.remove(id);
    useProvidersStore.setState((s) => {
      const { [id]: _, ...catalogs } = s.catalogs;
      return { items: s.items.filter((p) => p.id !== id), catalogs };
    });
    modelsActions.retryCatalog();
  },

  async refreshProviderModels(id: number) {
    await loadCatalog(id, true);
    modelsActions.retryCatalog();
  },
};

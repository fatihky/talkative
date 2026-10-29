/*
 * ProvidersClient — the /settings/providers body: the user's provider
 * connections above the merged model catalog.
 *
 * Business logic:
 * - Both sections share one provider filter, held here because it spans
 *   them: clicking a connection's name in the list focuses that provider
 *   in the catalog below, and the catalog's filter chips can set or clear
 *   the same filter. It narrows the model list already loaded, never
 *   refetching it.
 * - The filter is the connection name (what the catalog calls `provider`),
 *   so providers sharing a name filter together.
 * - The model list comes from GET /api/model-overrides (the catalog with
 *   the user's edits and added models), loaded here so a provider added or
 *   edited above reaches it: the first load refreshes the provider lists,
 *   later ones ride the server's cache.
 */
'use client';

import { useEffect, useRef, useState } from 'react';
import { actions, useProvidersStore } from '../stores';
import { ModelsSettings } from './models-settings';
import { ProviderSettings } from './provider-settings';

export function ProvidersClient() {
  /* the connection name the catalog is filtered by; '' = all. Held here so
     both sections share it. */
  const [focused, setFocused] = useState('');
  const providers = useProvidersStore((s) => s.items);
  /* what the list was loaded for: the first load refreshes the provider
     catalogs, later ones (after a connection changed) ride the cache */
  const loaded = useRef<typeof providers | null>(null);
  useEffect(() => {
    if (loaded.current === providers) return;
    void actions.load(loaded.current === null);
    loaded.current = providers;
  }, [providers]);
  return (
    <div className="contents">
      <ProviderSettings
        focusedProvider={focused || undefined}
        onFocusProvider={(p) => setFocused(p ?? '')}
      />
      <ModelsSettings
        focusProvider={focused || undefined}
        onFocusProvider={(p) => setFocused(p ?? '')}
      />
    </div>
  );
}

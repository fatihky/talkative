/*
 * ProvidersClient — the /settings/providers body: the user's provider
 * connections above the merged model catalog.
 *
 * Business logic:
 * - Both sections share one provider filter, held here because it spans
 *   them: clicking a connection's name in the list focuses that provider
 *   in the catalog below, and the catalog's filter chips can set or clear
 *   the same filter.
 * - The filter is the connection name (what the catalog calls `provider`),
 *   so providers sharing a name filter together.
 */
'use client';

import { useState } from 'react';
import { ModelsSettings } from './models-settings';
import { ProviderSettings } from './provider-settings';

export function ProvidersClient() {
  /* the connection name the catalog is filtered by; '' = all */
  const [focused, setFocused] = useState('');
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

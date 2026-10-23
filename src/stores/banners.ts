/*
 * useBanners / bannerActions — the app-wide warning strip. Derived state,
 * not a store: the list is rebuilt from other stores on every render.
 *
 * Business logic:
 * - banners come from network, models, providers, ui and estimate in a
 *   fixed order: offline, catalog error, rate-limited search provider,
 *   per-provider model failures, context overflow.
 * - the estimate subscription reports tokens only while overflowing, so
 *   typing in the composer doesn't churn the banner list.
 * - per-provider model errors show only while the merged catalog is still
 *   healthy: one bad key, unreachable provider or undecryptable stored
 *   key shouldn't duplicate the catalog banner.
 * - the overflow banner is home-only (ui.context === 'new'), where the
 *   text and attachments it blames can still be edited.
 * - bannerAction dispatches an action kind into other stores: retry the
 *   catalog, navigate to /settings, switch web_search to serper.dev (and
 *   toast it), select the first healthy model with a ≥1M window, or drop
 *   the largest attachment by bytes.
 * - those last two are best effort: with no big model or no attachment
 *   they simply do nothing, and unknown kinds are ignored.
 */
'use client';

import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { timeAgo } from '../lib/format';
import type { Banner } from '../types';
import { draftActions, useDraftStore } from './draft';
import { useEstimate } from './estimate';
import { modelsActions, useModelsStore } from './models';
import { useNetworkStore } from './network';
import { useProvidersStore } from './providers';
import { uiActions, useUIStore } from './ui';

export function useBanners(): Banner[] {
  const connection = useNetworkStore((s) => s.connection);
  const rl = useNetworkStore((s) =>
    s.providers.find((p) => p.status === 'rate_limited'),
  );
  const catalog = useModelsStore(
    useShallow((s) => ({ status: s.status, lastSyncedAt: s.lastSyncedAt })),
  );
  const providerErrors = useModelsStore(useShallow((s) => s.errors));
  const providers = useProvidersStore((s) => s.items);
  const onHome = useUIStore((s) => s.context === 'new');
  /* only track token counts while overflowing, so typing doesn't churn the banner list */
  const ov = useEstimate((e) => ({
    overflow: e.overflow,
    used: e.overflow ? e.contextUsed : 0,
    window: e.overflow ? (e.window ?? 0) : 0,
  }));

  return useMemo(() => {
    const out: Banner[] = [];
    if (connection === 'offline')
      out.push({
        id: 'b-offline',
        level: 'warn',
        text: 'Offline — messages will send on reconnect',
      });
    if (catalog.status === 'error') {
      const age = catalog.lastSyncedAt ? timeAgo(catalog.lastSyncedAt) : null;
      out.push({
        id: 'b-catalog',
        level: 'error',
        text: `Model catalog unavailable${age ? ` — using cached data (${age} old)` : ''}.`,
        actions: [
          { label: 'Retry', kind: 'retry-catalog' },
          { label: 'Configure provider', kind: 'configure-provider' },
        ],
      });
    }
    if (rl)
      out.push({
        id: 'b-rl',
        level: 'warn',
        text: `${rl.label.toLowerCase()} rate-limited · resets in ${rl.resetInSec ?? '??'}s`,
        actions: [{ label: 'Switch to serper.dev', kind: 'switch-provider' }],
      });
    /* a single provider can fail (bad key, unreachable, or an undecryptable
       stored key) while the merged catalog is still "ready" — surface it */
    const failed = providers.filter((p) => providerErrors[String(p.id)]);
    if (failed.length && catalog.status !== 'error') {
      const names = failed.map((p) => p.name);
      const first = providerErrors[String(failed[0]?.id)] ?? '';
      out.push({
        id: 'b-provider-models',
        level: 'error',
        text:
          names.length === 1
            ? `Couldn't load models from ${names[0]}${first ? ` — ${first}` : ''}`
            : `Couldn't load models from ${names.length} providers: ${names.join(', ')}`,
        actions: [
          { label: 'Retry', kind: 'retry-catalog' },
          { label: 'Configure provider', kind: 'configure-provider' },
        ],
      });
    }
    if (ov.overflow && onHome)
      out.push({
        id: 'b-overflow',
        level: 'error',
        text: `Context overflow — ${ov.used.toLocaleString()} est. tokens exceed the ${ov.window.toLocaleString()} window.`,
        actions: [
          { label: 'Switch to a 1M model', kind: 'use-1m-model' },
          { label: 'Trim attachments', kind: 'trim-attachments' },
        ],
      });
    return out;
  }, [connection, rl, catalog, providerErrors, providers, onHome, ov]);
}

export const bannerActions = {
  bannerAction(kind: string) {
    switch (kind) {
      case 'retry-catalog':
        modelsActions.retryCatalog();
        break;
      case 'configure-provider':
        uiActions.navigateTo('/settings');
        break;
      case 'switch-provider':
        draftActions.setToolProvider('web_search', 'serper.dev');
        uiActions.toast('web_search now uses serper.dev');
        break;
      case 'use-1m-model': {
        const big = useModelsStore
          .getState()
          .items.find(
            (m) => m.status === 'ok' && (m.context.window ?? 0) >= 1_000_000,
          );
        if (big) draftActions.setModel(big.id);
        break;
      }
      case 'trim-attachments': {
        const sorted = [...useDraftStore.getState().attachments].sort(
          (a, b) => (b.bytes ?? 0) - (a.bytes ?? 0),
        );
        const victim = sorted[0];
        if (victim) draftActions.removeAttachment(victim.id);
        break;
      }
    }
  },
};

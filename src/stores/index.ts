/*
 * stores — the barrel the UI imports from: one client-state layer, one
 * import path.
 *
 * Convention: a module per concern, each exporting a `useXStore` zustand
 * hook (state plus the selectors components subscribe to) and an
 * `xActions` object holding its only writers; banners and estimate are
 * pure derivations with no store of their own. Components take hooks and
 * mutations from here, and reach into a module only for helpers that
 * aren't actions (errorText, branchPath, setPendingFolder).
 *
 * Business logic:
 * - re-exports only: no state, no effects, nothing that can go stale.
 * - `actions` spreads every action object into one namespace so a call
 *   site doesn't have to know which store owns a mutation; the names are
 *   unique across modules, so no spread shadows another.
 * - shared types travel with their store (Estimate, PanelTab, Thread,
 *   ProviderCatalog, …) and are re-exported alongside the hooks.
 */
'use client';

import { artifactsActions } from './artifacts';
import { bannerActions } from './banners';
import { bootActions } from './boot';
import { chatsActions } from './chats';
import { decisionsActions } from './decisions';
import { draftActions } from './draft';
import { foldersActions } from './folders';
import { layoutActions } from './layout';
import { memoriesActions } from './memories';
import { notesActions } from './notes';
import { prefsActions } from './prefs';
import { providersActions } from './providers';
import { publishedActions } from './published';
import { sendActions } from './send';
import { threadsActions } from './threads';
import { privateActions } from './transient';
import { uiActions } from './ui';

export { useArtifactsStore } from './artifacts';
export { useBanners } from './banners';
export { useChatsStore, useRecentModelIds } from './chats';
export { useDecisionsStore } from './decisions';
export {
  enabledToolCount,
  modelDisabledTools,
  paramDirtyKeys,
  setComposerEl,
  useDraftStore,
  useEnabledToolCount,
  useSelectedModel,
} from './draft';
export { type Estimate, useEstimate } from './estimate';
export { folderPath, isWithin, useFoldersStore } from './folders';
export { useLayoutStore } from './layout';
export type { PanelTab, PreviewSnippet } from './layout';
export { useMemoriesStore } from './memories';
export { useModelsStore } from './models';
export { useNetworkStore } from './network';
export { useNotesStore } from './notes';
export { usePrefsStore } from './prefs';
export { type ProviderCatalog, useProvidersStore } from './providers';
export { usePublishedStore } from './published';
export { type Msg, type Thread, useThreadsStore } from './threads';
export { type PrivateMsg, usePrivateStore } from './transient';
export { useToolsStore } from './tools';
export { type ModelBarPopover, useUIStore } from './ui';

/** every action across stores, for call sites that don't care which store owns it */
export const actions = {
  ...bootActions,
  ...prefsActions,
  ...layoutActions,
  ...uiActions,
  ...chatsActions,
  ...foldersActions,
  ...draftActions,
  ...threadsActions,
  ...sendActions,
  ...notesActions,
  ...decisionsActions,
  ...privateActions,
  ...bannerActions,
  ...providersActions,
  ...memoriesActions,
  ...artifactsActions,
  ...publishedActions,
};

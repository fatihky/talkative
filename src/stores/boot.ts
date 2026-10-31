/*
 * bootActions — the one-shot client startup sequence (§7.1) plus the dev
 * switches that re-run parts of it.
 *
 * Business logic:
 * - boot() is idempotent behind ui.booted and is called from the shell's
 *   mount effect; it seeds layout, prefs and theme from localStorage,
 *   applies the theme, and reopens with the right panel closed.
 * - the stage shows immediately when a cache exists; on a cold boot a
 *   timer reveals it after at most 800ms so a slow catalog can't leave
 *   the reader staring at nothing.
 * - stale-while-revalidate: cache.models/cache.modelsAt, cache.chats,
 *   cache.folders + folders.expanded and cache.notes fill their stores as
 *   'ready' before any request lands, with pre-firstPrompt chats
 *   backfilled and pre-server notes (no createdAt) dropped.
 * - home.lastParams restores the tool grants, providers, counts and
 *   concurrencies over the compiled defaults — a tool added since keeps
 *   its default grant — plus thinking level and param overrides; a
 *   non-empty home.draft comes back with the draft notice raised, and a
 *   systemPrompt saved on it (typed for an unsent chat) is restored too.
 * - only models and chats gate the stage: they resolve together, then the
 *   selected model is resolved (which also clamps the thinking level),
 *   suggestions are refetched, and the composer takes focus when the
 *   viewport is ≥1100px and there's no deep-link hash. tools, folders,
 *   notes and provider health load in parallel without gating, and a
 *   failure only downgrades its own store if it has no cache to show.
 * - that model step only runs on a new-chat context: reloading on a chat
 *   page lets the thread reopen with the chat's own model, so the
 *   new-chat default can neither replace what the chat shows nor slip
 *   into the next chat through the persisted home.draft.
 * - server-saved tool preferences override the localStorage copy, and are
 *   skipped entirely while simulating offline; the account-level composer
 *   prefs (enterToSend) are fetched the same way and keep the cached copy
 *   if they don't arrive.
 * - boot also wires the online/offline listeners: connection becomes
 *   offline / degraded / connected, and reconnecting with queued sends
 *   flushes them.
 * - setDev patches the simulation flags, re-syncs the connection, and
 *   re-runs only the affected fetch (catalog, provider health, chats,
 *   suggestions) so the status bar demos stay cheap.
 */
'use client';

import {
  type DevFlags,
  fetchChats,
  fetchFolders,
  fetchModels,
  fetchNotes,
  fetchProviderHealth,
  fetchSuggestions,
  fetchTools,
  fetchUserPrefs,
  toolPreferencesApi,
} from '../lib/api';
import { modKey } from '../lib/format';
import { hasCache, LS } from '../lib/storage';
import {
  DEFAULT_CONCURRENCIES,
  DEFAULT_COUNTS,
  DEFAULT_GRANTS,
  DEFAULT_PROVIDERS,
} from '../lib/tools';
import type {
  ChatSummary,
  ConnStatus,
  Draft,
  Folder,
  Model,
  Note,
  Prefs,
} from '../types';
import { useChatsStore } from './chats';
import {
  applyToolPreferences,
  draftActions,
  type LastParams,
  resolveModelId,
  setDraft,
  useDraftStore,
} from './draft';
import { setFolderItems, useFoldersStore } from './folders';
import { useLayoutStore } from './layout';
import {
  applyModels,
  errorText,
  failModels,
  setModelErrors,
  useModelsStore,
} from './models';
import { isOffline, useNetworkStore } from './network';
import { setNoteItems, useNotesStore } from './notes';
import { defaultPrefs, prefsActions, usePrefsStore } from './prefs';
import { sendActions } from './send';
import { setToolStatuses, useToolsStore } from './tools';
import { useUIStore } from './ui';

/* connection sync, wired up by boot() */
let syncConn: (() => void) | null = null;

const refreshProviders = (dev: DevFlags) =>
  fetchProviderHealth(dev)
    .then((h) =>
      useNetworkStore.setState({
        providers: h.providers,
        latencyMs: h.latencyMs,
      }),
    )
    .catch(() => {});

const refreshSuggestions = (dev: DevFlags) =>
  fetchSuggestions(dev)
    .then((suggestions) => useChatsStore.setState({ suggestions }))
    .catch(() => useChatsStore.setState({ suggestions: [] }));

export const bootActions = {
  /* boot / init sequence (§7.1) */
  boot() {
    const ui = useUIStore.getState();
    if (ui.booted) return;
    const cached = hasCache();
    const layout = LS.get('layout.sidebar', { width: 264, collapsed: false });
    const rp = LS.get('layout.rightPanel', { width: 440 });
    const prefs = LS.get('prefs', defaultPrefs());
    const theme = LS.get<Prefs['theme']>('theme', 'system');

    useUIStore.setState({
      booted: true,
      stageVisible: cached,
      mod: modKey() === '⌘' ? '⌘' : 'Ctrl',
    });
    useLayoutStore.setState({
      sidebarWidth: layout.width,
      sidebarCollapsed: layout.collapsed,
      rightPanel: 'closed',
      rightPanelWidth: rp.width,
      mobileNav: false,
      vw: window.innerWidth,
    });
    usePrefsStore.setState({ ...prefs, theme });
    prefsActions.applyTheme();

    /* stale-while-revalidate from cache */
    const cModels = LS.get<Model[]>('cache.models', []);
    /* chats cached before firstPrompt/createdAt existed lack them */
    const cChats = LS.get<ChatSummary[]>('cache.chats', []).map((c) => ({
      ...c,
      firstPrompt: c.firstPrompt ?? '',
      createdAt: c.createdAt ?? c.updatedAt,
    }));
    if (cModels.length > 0)
      useModelsStore.setState({
        items: cModels,
        status: 'ready',
        lastSyncedAt: LS.get('cache.modelsAt', null),
      });
    if (cChats.length > 0)
      useChatsStore.setState({ items: cChats, status: 'ready', filter: '' });
    const cFolders = LS.get<Folder[]>('cache.folders', []);
    useFoldersStore.setState({
      items: cFolders,
      status: cFolders.length > 0 ? 'ready' : 'loading',
      expanded: LS.get('folders.expanded', {}),
    });
    /* notes cached before they were persisted server-side lack createdAt */
    const cNotes = LS.get<Note[]>('cache.notes', []).filter(
      (n) => typeof n.createdAt === 'number',
    );
    useNotesStore.setState({
      notes: cNotes,
      status: cNotes.length > 0 ? 'ready' : 'loading',
    });

    /* S1 cold boot: stage hidden until models resolve, max 800ms */
    if (!cached) {
      setTimeout(() => {
        if (!useUIStore.getState().stageVisible)
          useUIStore.setState({ stageVisible: true });
      }, 800);
    }

    /* restore last params + draft (§6) */
    const lastParams = LS.get<LastParams | null>('home.lastParams', null);
    /* §7.1 step 5: tool defaults from permission matrix 'all chats' scope;
       tools added since keep their default grant */
    draftActions.setDefaultTools({
      grants: { ...DEFAULT_GRANTS, ...lastParams?.grants },
      providers: { ...DEFAULT_PROVIDERS, ...lastParams?.providers },
      counts: { ...DEFAULT_COUNTS, ...lastParams?.counts },
      concurrency: { ...DEFAULT_CONCURRENCIES, ...lastParams?.concurrency },
    });
    if (lastParams)
      setDraft({
        thinkingLevel: lastParams.level,
        paramOverrides: lastParams.overrides,
        paramScope: lastParams.scope,
      });

    const storedDraft = LS.get<(Draft & { systemPrompt?: string }) | null>(
      'home.draft',
      null,
    );
    if (
      storedDraft &&
      (storedDraft.text || storedDraft.attachments.length > 0)
    ) {
      /* tool choices come from lastParams, which the debounced draft can lag */
      setDraft({
        text: storedDraft.text,
        attachments: storedDraft.attachments,
        modelId: storedDraft.modelId,
        thinkingLevel: storedDraft.thinkingLevel,
        paramOverrides: storedDraft.paramOverrides,
        paramScope: storedDraft.paramScope,
      });
      useUIStore.setState({ draftNotice: true });
    }
    /* a prompt typed for an unsent chat survives a reload on its own */
    if (storedDraft?.systemPrompt)
      useDraftStore.setState({ systemPrompt: storedDraft.systemPrompt });

    /* parallel fetches (§7.1 step 3) */
    if (useModelsStore.getState().status !== 'ready')
      useModelsStore.setState({ status: 'loading' });
    if (useChatsStore.getState().status !== 'ready')
      useChatsStore.setState({ status: 'loading' });

    const { dev } = useNetworkStore.getState();
    const modelsP = fetchModels(dev)
      .then((m) => {
        setModelErrors(m.errors);
        return m;
      })
      .catch((e: unknown) => {
        failModels(errorText(e));
        useNetworkStore.setState({ lastError: errorText(e) });
        return null;
      });
    const chatsP = fetchChats(dev).catch(() => {
      useChatsStore.setState({ status: 'error' });
      return null;
    });
    /* tool readiness only greys out grants, so it doesn't gate the stage either */
    useToolsStore.setState({ status: 'loading' });
    void fetchTools(dev)
      .then(setToolStatuses)
      .catch(() => useToolsStore.setState({ status: 'error' }));
    /* saved tool choices override the localStorage copy restored above */
    if (!dev.simulateOffline)
      void toolPreferencesApi
        .get()
        .then(applyToolPreferences)
        .catch(() => {});
    /* the composer's Enter key is an account pref: the cached value paints
       first, the saved one lands a moment later */
    void fetchUserPrefs(dev)
      .then(prefsActions.applyAccountPrefs)
      .catch(() => {});
    /* folders only shape the sidebar, so they don't gate the stage */
    void fetchFolders(dev)
      .then((items) => {
        setFolderItems(items);
        useFoldersStore.setState({ status: 'ready' });
      })
      .catch(() => {
        if (useFoldersStore.getState().status !== 'ready')
          useFoldersStore.setState({ status: 'error' });
      });
    void fetchNotes(dev)
      .then((items) => {
        setNoteItems(items);
        useNotesStore.setState({ status: 'ready' });
      })
      .catch(() => {
        if (useNotesStore.getState().status !== 'ready')
          useNotesStore.setState({ status: 'error' });
      });
    void fetchProviderHealth(dev)
      .then((h) =>
        useNetworkStore.setState({
          providers: h.providers,
          latencyMs: h.latencyMs,
        }),
      )
      .catch(() => null);

    void Promise.all([modelsP, chatsP]).then(([m, c]) => {
      if (m) applyModels(m);
      if (c) {
        useChatsStore.setState({ items: c, status: 'ready', filter: '' });
        LS.set('cache.chats', c);
      }
      /* §7.1 step 4: resolve selected model (also applies step 6 clamp).
         On a chat page the thread reopens with the chat's own model
         (ThreadScreen → loadThread), so seeding the composer here would only
         clobber it — and the persisted draft it mirrors — with the new-chat
         default. Home and every other screen are context 'new'. */
      if (useUIStore.getState().context === 'new')
        draftActions.setModel(resolveModelId(), true);
      if (!useUIStore.getState().stageVisible && !cached)
        useUIStore.setState({ stageVisible: true });

      void refreshSuggestions(useNetworkStore.getState().dev);

      /* §7.1 step 2: focus only if ≥1100px and no deep-link hash; caret to end */
      requestAnimationFrame(() => {
        if (window.innerWidth >= 1100 && !window.location.hash)
          draftActions.focusComposer();
      });
    });

    /* connection listeners (§7.2 / S10) */
    syncConn = () => {
      const net = useNetworkStore.getState();
      const offline = isOffline();
      const conn: ConnStatus = offline
        ? 'offline'
        : net.dev.degraded
          ? 'degraded'
          : 'connected';
      if (conn !== net.connection) {
        useNetworkStore.setState({ connection: conn });
        if (!offline && net.queued.length > 0) sendActions.flushQueue();
      }
    };
    window.addEventListener('online', () => {
      syncConn?.();
      void refreshProviders(useNetworkStore.getState().dev);
    });
    window.addEventListener('offline', () => syncConn?.());
    syncConn();
  },

  setDev(patch: Partial<DevFlags>) {
    const dev = { ...useNetworkStore.getState().dev, ...patch };
    useNetworkStore.setState({ dev });
    syncConn?.();
    if ('failCatalog' in patch) {
      if (patch.failCatalog)
        failModels('Model catalog unavailable (simulated)');
      else void fetchModels(dev).then(applyModels);
    }
    if ('rateLimited' in patch) void refreshProviders(dev);
    if ('emptyChats' in patch) {
      void fetchChats(dev)
        .then((items) => useChatsStore.setState({ items, status: 'ready' }))
        .catch(() => {});
    }
    if ('emptySuggestions' in patch) void refreshSuggestions(dev);
  },
};

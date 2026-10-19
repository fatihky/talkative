/*
 * useDraftStore / draftActions — the composer's draft: text, attachments,
 * model, thinking level, param overrides and the tool selection it shows.
 *
 * Business logic:
 * - every setDraft() write is mirrored to localStorage 'home.draft'
 *   (debounced 400ms), persistParams() writes 'home.lastParams' (thinking
 *   level, overrides, scope, account-wide tool choices) and setModel
 *   writes 'home.lastModel', the default a new chat starts on; boot
 *   restores all three and a successful send clears the draft.
 * - tool choices are layered: account-wide defaultTools, then a per-chat
 *   copy held in a module-scoped map (never serialized), reapplied
 *   whenever ui.context changes so the tool bar always belongs to the
 *   chat being composed in.
 * - commitTools picks the layer: once the open thread has a first message
 *   an edit stays thread-wide; before that, or on home, it edits the
 *   account defaults and saves them through one debounced 400ms PUT. the
 *   first local edit marks the prefs touched, so a late boot fetch can't
 *   clobber it, and a failed PUT is toasted rather than retried.
 * - grants that can't take effect never reach the server: a tool counts as
 *   disabled when the server reports it unavailable or the selected model
 *   lacks its required capability, and effectiveGrants() filters those
 *   out; a stored turn lists only granted tools, so normalizeGrants()
 *   treats every missing id as off.
 * - enabling a tool flagged `confirm` routes through the confirm dialog
 *   first, and bulk toggles (all tools, or one section) never switch such
 *   a tool on and skip disabled ones; counts and concurrency are always
 *   account-wide.
 * - choosing a model clamps the thinking level to what it supports
 *   (nearest level, explained by a clampNote), while an explicit switch
 *   adopts the model's own default reasoning level instead. resolveModelId
 *   falls back lastModel → workspace default → first healthy model, and
 *   applyChatModel ignores a model the catalog no longer has so the bar
 *   doesn't read '—'.
 * - setModel writes 'home.lastModel' — the model a new chat starts on —
 *   only when it actually switches the composer, and boot restores it. To
 *   change one chat's model without touching that default, the pickers call
 *   switchChatModel (open chat) or applyChatModel (reopening a chat), which
 *   re-select the model and their own chat's turn records it; browsing or
 *   changing a chat therefore can't move the default underneath the next.
 * - text past 2000 chars raises the long-paste notice, which
 *   convertPasteToFile answers by moving it into a pasted-text.txt
 *   attachment; discardDraft/resetDraft go back to a fresh draft (default
 *   tool choices kept, thinking level 'medium', resetDraft re-resolving
 *   the model), and newChat routes home first so an open thread doesn't
 *   stay on screen.
 * - composerEl is a module-scoped DOM ref kept out of serialized state,
 *   used to focus the textarea with the caret at the end.
 * - pendingFolderId files the next chat started from a folder screen into
 *   that folder; the send flow consumes it.
 * - systemPrompt is the chat-scope prompt typed on home, before a chat
 *   exists: home.draft carries it, the first send hands it to the server
 *   (which stores it on the row it creates) and beginSend seeds the new
 *   chat's sidebar row with it, so the right panel switches over to it.
 */
'use client';

import { create } from 'zustand';
import { toolPreferencesApi } from '../lib/api';
import { debouncedSet, LS, uid } from '../lib/storage';
import {
  DEFAULT_CONCURRENCIES,
  DEFAULT_COUNTS,
  DEFAULT_GRANTS,
  DEFAULT_PROVIDERS,
  TOOLS,
} from '../lib/tools';
import { isChattable } from '../lib/models';
import type {
  Attachment,
  Draft,
  Model,
  ParamScope,
  ProviderId,
  ThinkingLevel,
  ToolId,
  ToolPreferences,
  ToolStatus,
} from '../types';
import { useFoldersStore } from './folders';
import { useModelsStore } from './models';
import { useThreadsStore } from './threads';
import { useToolsStore } from './tools';
import { uiActions, useUIStore } from './ui';

const LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high'];
const WORKSPACE_DEFAULT_MODEL = 'claude-4.5-sonnet';
/* mirrors SYSTEM_PROMPT_MAX in server/chats.ts */
const SYSTEM_PROMPT_MAX = 20_000;

export const defaultDraft = (modelId: string): Draft => ({
  text: '',
  attachments: [],
  modelId,
  thinkingLevel: 'medium',
  toolGrants: { ...DEFAULT_GRANTS },
  toolProviders: { ...DEFAULT_PROVIDERS },
  paramOverrides: {},
  paramScope: 'chat',
});

export type DraftState = Draft & {
  pendingFolderId: string | null;
  /** account-wide tool choices, edited from the home composer and the /tools screen */
  defaultTools: ToolPreferences;
  /** the prompt for a chat that doesn't exist yet; home-only, cleared on send/reset */
  systemPrompt: string;
};

/** The home composer draft. */
export const useDraftStore = create<DraftState>(() => ({
  ...defaultDraft(WORKSPACE_DEFAULT_MODEL),
  pendingFolderId: null,
  systemPrompt: '',
  defaultTools: {
    grants: { ...DEFAULT_GRANTS },
    providers: { ...DEFAULT_PROVIDERS },
    counts: { ...DEFAULT_COUNTS },
    concurrency: { ...DEFAULT_CONCURRENCIES },
  },
}));

const get = useDraftStore.getState;
export const setDraft = (patch: Partial<Draft>) => {
  useDraftStore.setState(patch);
  debouncedSet('home.draft', get(), 400);
};

/* module-scoped DOM ref that must not live in serialized state */
let composerEl: HTMLTextAreaElement | null = null;
export const setComposerEl = (el: HTMLTextAreaElement | null) => {
  composerEl = el;
};

/* ── per-chat tool selections ────────────────────────────────────── */

/* keyed by chat id, out of the serialized draft; a chat with none of its own shows the defaults */
const chatTools = new Map<string, ToolPreferences>();

/** points the composer's tool bar at `context`'s own selection, or the defaults on home */
export const applyContextTools = (context: string) => {
  const own = context === 'new' ? undefined : chatTools.get(context);
  const sel = own ?? get().defaultTools;
  setDraft({
    toolGrants: { ...sel.grants },
    toolProviders: { ...sel.providers },
  });
};

/** records the selection a chat is composed with, and shows it if that chat is open */
const rememberChatTools = (chatId: string, sel: ToolPreferences) => {
  chatTools.set(chatId, sel);
  if (useUIStore.getState().context === chatId) applyContextTools(chatId);
};

/** the chat a turn goes to keeps the selection its composer currently shows */
export const rememberActiveTools = (chatId: string) => {
  const { toolGrants, toolProviders, defaultTools } = get();
  rememberChatTools(chatId, {
    grants: toolGrants,
    providers: toolProviders,
    counts: defaultTools.counts,
    concurrency: defaultTools.concurrency,
  });
};

export const forgetChatTools = (chatId: string) => {
  chatTools.delete(chatId);
};

/** a stored turn lists only the tools that were granted; every other one is off */
export const normalizeGrants = (
  grants: Record<ToolId, boolean> | undefined,
): Record<ToolId, boolean> =>
  Object.fromEntries(
    TOOLS.map((t) => [t.id, grants?.[t.id] === true]),
  ) as Record<ToolId, boolean>;

/* the tool bar belongs to the chat being composed in, so switching chats swaps the selection */
useUIStore.subscribe((s, prev) => {
  if (s.context !== prev.context) applyContextTools(s.context);
});

export type LastParams = {
  level: ThinkingLevel;
  grants: Record<ToolId, boolean>;
  providers: Record<ToolId, ProviderId>;
  counts: Record<ToolId, number>;
  concurrency: Record<ToolId, number>;
  overrides: Record<string, unknown>;
  scope: ParamScope;
};

/* ── selectors ───────────────────────────────────────────────────── */

export const findModel = (items: Model[], id: string): Model | null =>
  items.find((m) => m.id === id) ?? null;

export const getSelectedModel = (): Model | null =>
  findModel(useModelsStore.getState().items, get().modelId);

export const useSelectedModel = (): Model | null => {
  const id = useDraftStore((s) => s.modelId);
  return useModelsStore((s) => findModel(s.items, id));
};

/** tools that can't be granted right now: unsupported by the model or not runnable on the server */
export const modelDisabledTools = (
  model: Model | null,
  statuses: Record<ToolId, ToolStatus> = useToolsStore.getState().items,
): Map<ToolId, string> => {
  const out = new Map<ToolId, string>();
  for (const t of TOOLS) {
    const s = statuses[t.id];
    if (s && !s.available)
      out.set(t.id, `${t.label}: ${s.reason ?? 'unavailable'}`);
    else if (
      model &&
      t.requiresCapability &&
      !model.capabilities[t.requiresCapability]
    )
      out.set(t.id, `${model.shortName} does not support ${t.label}`);
  }
  return out;
};

/* only grants that can take effect go to the server */
export const effectiveGrants = (): Record<ToolId, boolean> => {
  const disabled = modelDisabledTools(getSelectedModel());
  return Object.fromEntries(
    Object.entries(get().toolGrants).filter(
      ([id, on]) => on && !disabled.has(id),
    ),
  );
};

export const enabledToolCount = (grants: Draft['toolGrants']): number =>
  TOOLS.filter((t) => grants[t.id] === true).length;

export const useEnabledToolCount = () =>
  useDraftStore((s) => enabledToolCount(s.toolGrants));

/** files the home draft's next chat into `id` (null = unfiled), for the folder screen */
export const setPendingFolder = (id: string | null) =>
  useDraftStore.setState({ pendingFolderId: id });

export const paramDirtyKeys = (_d: Record<string, unknown>): string[] =>
  Object.keys(_d);

/* ── helpers ─────────────────────────────────────────────────────── */

const clampLevel = (
  want: ThinkingLevel,
  model: Model | null,
): { level: ThinkingLevel; changed: boolean } => {
  if (!model || model.thinkingLevels === undefined)
    return { level: want, changed: false };
  if (model.thinkingLevels.length === 0)
    return { level: 'off', changed: want !== 'off' };
  if (model.thinkingLevels.includes(want))
    return { level: want, changed: false };
  const wIdx = LEVELS.indexOf(want);
  let best: ThinkingLevel = model.thinkingLevels[0] ?? 'medium';
  let bestD = 99;
  for (const l of model.thinkingLevels) {
    const d = Math.abs(LEVELS.indexOf(l) - wIdx);
    if (d < bestD) {
      bestD = d;
      best = l;
    }
  }
  return { level: best, changed: true };
};

export const resolveModelId = (): string => {
  const { items } = useModelsStore.getState();
  const last = LS.get<string>('home.lastModel', '');
  const ok = (id: string) =>
    items.find((m) => m.id === id && m.status !== 'error' && isChattable(m));
  if (last && ok(last)) return last;
  const def = ok(WORKSPACE_DEFAULT_MODEL);
  if (def) return def.id;
  /* embedding/decision models can't chat, so they can't be the composer default */
  const firstOk = items.find((m) => m.status === 'ok' && isChattable(m));
  return firstOk?.id ?? WORKSPACE_DEFAULT_MODEL;
};

/* tool grants and backend picks are user preferences, so a fresh draft keeps them */
const freshDraft = (modelId: string): Draft => ({
  ...defaultDraft(modelId),
  toolGrants: { ...DEFAULT_GRANTS, ...get().defaultTools.grants },
  toolProviders: { ...DEFAULT_PROVIDERS, ...get().defaultTools.providers },
});

/* tool choices are saved server-side; one debounced PUT covers bulk toggles */
let toolPrefsTimer: ReturnType<typeof setTimeout> | null = null;
/* set once the user edits locally, so a late boot fetch can't clobber the edit */
let toolPrefsTouched = false;

/* the selection travels with the call: navigating away mid-debounce must not save another chat's */
const saveToolPrefs = (prefs: ToolPreferences) => {
  toolPrefsTouched = true;
  if (toolPrefsTimer) clearTimeout(toolPrefsTimer);
  toolPrefsTimer = setTimeout(() => {
    toolPrefsTimer = null;
    toolPreferencesApi.put(prefs).catch((err) => {
      const msg = err instanceof Error ? err.message : 'unknown error';
      console.error('[tool-prefs] save failed:', msg);
      uiActions.toast(`Could not save tool settings: ${msg}`, 'error');
    });
  }, 400);
};

/** applies the saved server prefs at boot, unless the user already changed something */
export const applyToolPreferences = (p: ToolPreferences) => {
  if (toolPrefsTouched) return;
  draftActions.setDefaultTools({
    grants: { ...DEFAULT_GRANTS, ...p.grants },
    providers: { ...DEFAULT_PROVIDERS, ...p.providers },
    counts: { ...DEFAULT_COUNTS, ...p.counts },
    concurrency: { ...DEFAULT_CONCURRENCIES, ...p.concurrency },
  });
};

/** a tool edit belongs to the chat being composed in; only before its first message does it edit the account defaults */
const commitTools = (
  patch: Partial<Pick<Draft, 'toolGrants' | 'toolProviders'>>,
) => {
  setDraft(patch);
  const context = useUIStore.getState().context;
  const d = get();
  const sel = {
    grants: d.toolGrants,
    providers: d.toolProviders,
    counts: d.defaultTools.counts,
    concurrency: d.defaultTools.concurrency,
  };
  /* once the thread has sent its first message, changes stay thread-wide */
  const thread = context === 'new' ? undefined : useThreadsStore.getState().threads[context];
  const sentFirstMessage = (thread?.messages.length ?? 0) > 0;
  if (context !== 'new' && sentFirstMessage) {
    chatTools.set(context, sel);
    return;
  }
  useDraftStore.setState({ defaultTools: sel });
  draftActions.persistParams();
  saveToolPrefs(sel);
};

/** selects `id` in the composer and clamps the thinking level; does not touch the app-wide pick */
const applyModel = (id: string, fromBoot: boolean, quiet = false) => {
  const model = findModel(useModelsStore.getState().items, id);
  const want = get().thinkingLevel;
  setDraft({ modelId: id });
  /* on explicit switches, adopt the model's own default reasoning when it reports one */
  if (!fromBoot && model?.defaultThinkingLevel !== undefined) {
    setDraft({ thinkingLevel: model.defaultThinkingLevel });
    useUIStore.setState({ clampNote: null });
    draftActions.persistParams();
    return;
  }
  const clamp = clampLevel(want, model);
  if (clamp.changed) {
    setDraft({ thinkingLevel: clamp.level });
    if (!fromBoot && !quiet)
      useUIStore.setState({
        clampNote: `${model?.shortName ?? 'this model'} does not support “${want}” — adjusted to “${clamp.level}”`,
      });
  }
  draftActions.persistParams();
};

/* ── actions ─────────────────────────────────────────────────────── */

export const draftActions = {
  setText(text: string) {
    const prev = get().text;
    setDraft({ text });
    if (text.length > 2000 && prev.length <= 2000)
      useUIStore.setState({ longPaste: true });
  },
  discardDraft() {
    setDraft(freshDraft(get().modelId));
    useDraftStore.setState({ systemPrompt: '' });
    LS.set('home.draft', get());
    useUIStore.setState({ draftNotice: false, longPaste: false });
  },
  resetDraft() {
    setDraft(freshDraft(resolveModelId()));
    /* a new chat is unfiled until the folder screen claims it */
    useDraftStore.setState({ pendingFolderId: null, systemPrompt: '' });
    LS.set('home.draft', get());
    useUIStore.setState({
      draftNotice: false,
      longPaste: false,
      noToolsNote: false,
    });
    draftActions.focusComposer();
  },
  /* leaving a thread must route home too, or the open chat stays on screen */
  newChat() {
    if (window.location.pathname !== '/')
      useUIStore.setState({ pendingNav: '/' });
    draftActions.resetDraft();
  },
  insertPrompt(prompt: string) {
    const { text } = get();
    setDraft({ text: text.trim() === '' ? prompt : `${text}\n\n${prompt}` });
    draftActions.focusComposer();
  },
  /** the chat-scope prompt box on home: held on the draft until the first send stores it */
  setDraftSystemPrompt(text: string) {
    const systemPrompt = text.slice(0, SYSTEM_PROMPT_MAX);
    if (get().systemPrompt === systemPrompt) return;
    /* setDraft mirrors the whole draft, so the restored-prompt hint no longer applies */
    setDraft({});
    useDraftStore.setState({ systemPrompt });
    LS.set('home.draft', get());
    useUIStore.setState({ draftNotice: false });
  },
  focusComposer() {
    if (!composerEl) return;
    composerEl.focus();
    const n = composerEl.value.length;
    composerEl.setSelectionRange(n, n);
  },
  convertPasteToFile() {
    const { text, attachments } = get();
    setDraft({
      text: '',
      attachments: [
        ...attachments,
        {
          id: uid(),
          kind: 'file',
          name: 'pasted-text.txt',
          bytes: text.length,
          mime: 'text/plain',
        },
      ],
    });
    useUIStore.setState({ longPaste: false });
  },

  addAttachments(items: Attachment[]) {
    setDraft({ attachments: [...get().attachments, ...items] });
  },
  removeAttachment(id: string) {
    setDraft({ attachments: get().attachments.filter((a) => a.id !== id) });
  },

  /* model bar */
  /* the user's pick is the app-wide default used when a new chat starts, and a pick that
     switches the open chat's own model becomes its default too — a model the chat already
     uses (reloading, the boot restore) is not what the default is set by */
  setModel(id: string, fromBoot = false) {
    const previous = get().modelId;
    applyModel(id, fromBoot);
    if (fromBoot) return;
    const pick = get().modelId;
    if (pick === previous) return;
    LS.set('home.lastModel', pick);
  },
  /* reopening a chat pre-selects its last message's model, leaving the new-chat default alone */
  applyChatModel(id: string) {
    const { items } = useModelsStore.getState();
    /* a model the catalog no longer has would leave the composer on '—' */
    if (
      items.length > 0 &&
      !items.some((m) => m.id === id && m.status !== 'error')
    )
      return;
    applyModel(id, true);
  },
  /* re-picks the model of the chat being composed in and leaves the new-chat default alone;
     a preset the model can't do (e.g. medium thinking on a no-thinking model) clamps quietly */
  switchChatModel(id: string) {
    applyModel(id, false, true);
  },
  setThinkingLevel(level: ThinkingLevel) {
    setDraft({ thinkingLevel: level });
    useUIStore.setState({ clampNote: null });
    draftActions.persistParams();
  },
  setToolGrant(tool: ToolId, on: boolean, confirmed = false) {
    /* tools with a `confirm` note go through the confirm dialog, which calls back with confirmed */
    if (
      on &&
      !confirmed &&
      get().toolGrants[tool] !== true &&
      TOOLS.some((t) => t.id === tool && t.confirm)
    ) {
      useUIStore.setState({ confirmToolFor: tool });
      return;
    }
    commitTools({ toolGrants: { ...get().toolGrants, [tool]: on } });
    useUIStore.setState({ noToolsNote: false });
  },
  setAllToolGrants(on: boolean) {
    const disabled = modelDisabledTools(getSelectedModel());
    const next = { ...get().toolGrants };
    /* bulk enable never switches on a tool that needs a confirm */
    for (const t of TOOLS)
      next[t.id] =
        on && !disabled.has(t.id) && (!t.confirm || next[t.id] === true);
    commitTools({ toolGrants: next });
    useUIStore.setState({ noToolsNote: false });
  },
  /* bulk toggle for a subset (e.g. the GitHub section) with the same confirm/disabled rules */
  setToolGrants(toolIds: ToolId[], on: boolean) {
    const disabled = modelDisabledTools(getSelectedModel());
    const next = { ...get().toolGrants };
    for (const id of toolIds) {
      const needsConfirm = TOOLS.some((t) => t.id === id && t.confirm);
      next[id] =
        on && !disabled.has(id) && (!needsConfirm || next[id] === true);
    }
    commitTools({ toolGrants: next });
    useUIStore.setState({ noToolsNote: false });
  },
  setToolProvider(tool: ToolId, provider: ProviderId) {
    commitTools({ toolProviders: { ...get().toolProviders, [tool]: provider } });
  },
  setToolCount(tool: ToolId, count: number) {
    const sel: ToolPreferences = {
      grants: get().toolGrants,
      providers: get().toolProviders,
      counts: { ...get().defaultTools.counts, [tool]: count },
      concurrency: { ...get().defaultTools.concurrency },
    };
    useDraftStore.setState({ defaultTools: sel });
    draftActions.persistParams();
    saveToolPrefs(sel);
  },
  setToolConcurrency(tool: ToolId, concurrency: number) {
    const sel: ToolPreferences = {
      grants: get().toolGrants,
      providers: get().toolProviders,
      counts: { ...get().defaultTools.counts },
      concurrency: { ...get().defaultTools.concurrency, [tool]: concurrency },
    };
    useDraftStore.setState({ defaultTools: sel });
    draftActions.persistParams();
    saveToolPrefs(sel);
  },
  /** replaces the account-wide defaults and shows them wherever no chat has its own */
  setDefaultTools(prefs: ToolPreferences) {
    useDraftStore.setState({ defaultTools: prefs });
    applyContextTools(useUIStore.getState().context);
    draftActions.persistParams();
  },
  /** seeds a chat's selection from one of its stored turns; an edit made this session wins */
  adoptStoredTools(chatId: string, prefs: ToolPreferences) {
    if (!chatTools.has(chatId)) rememberChatTools(chatId, prefs);
  },
  setParamOverride(key: string, value: unknown) {
    setDraft({ paramOverrides: { ...get().paramOverrides, [key]: value } });
    draftActions.persistParams();
  },
  resetParams() {
    setDraft({ paramOverrides: {}, paramScope: 'chat' });
    draftActions.persistParams();
  },
  setParamScope(scope: ParamScope) {
    setDraft({ paramScope: scope });
    draftActions.persistParams();
  },
  persistParams() {
    const d = get();
    LS.set('home.lastParams', {
      level: d.thinkingLevel,
      grants: d.defaultTools.grants,
      providers: d.defaultTools.providers,
      counts: d.defaultTools.counts,
      concurrency: d.defaultTools.concurrency,
      overrides: d.paramOverrides,
      scope: d.paramScope,
    } satisfies LastParams);
  },
};

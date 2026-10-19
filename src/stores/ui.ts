/*
 * UIStore — cross-cutting client UI state: boot, auth, the active
 * context, overlays, notices, toasts and navigation requests.
 *
 * Business logic:
 * - booted makes boot() idempotent, and stageVisible holds the boot stage
 *   until the catalog resolves (or 800ms pass on a cold boot);
 *   authLoading and isAuthenticated mirror better-auth's session so
 *   ShellWrapper renders nothing while checking and the bare layout when
 *   signed out.
 * - context is 'new' on home or a chat id in a chat: every screen sets it
 *   on mount, the sidebar highlights the matching row, the estimate and
 *   the per-chat tool selection key off it, and beginSend flips it to the
 *   new chat id so the composer follows the send.
 * - pendingNav is the store's navigation channel — navigateTo parks a
 *   route path or a bare chat id, shell's effect pushes it (prefixing
 *   /c/ for a bare id) and clears it, which is how stores route without
 *   holding a router.
 * - palette, help, devOpen, systemPromptFor, confirmToolFor and
 *   modelBarPopover are independent overlay flags; openModelBarPopover
 *   swaps instantly because only one model/tool-bar popover may be open,
 *   and closeModelBarPopover can put focus back on its trigger. the
 *   system-prompt target sits here rather than in the sidebar row that
 *   opens it, since that row unmounts when the list virtualizes it away.
 *   chatModelPicker holds the chat whose model the chat-model dialog is
 *   picking; it opens from the sidebar row and the thread header, so the
 *   dialog has to live outside both.
 * - confirm() opens the modal and returns a promise the dialog answers
 *   through answerConfirm; the resolver is kept outside state and opening
 *   another confirm resolves the pending one false, so only one is ever
 *   open and cancel or esc reads as "no".
 * - sending is true from a home send starting until its POST settles —
 *   the send button's spinner.
 * - toasts append with a generated id and dismiss themselves after 3.5s;
 *   dismissToast removes one early.
 * - draftNotice, longPaste, noToolsNote, noticesExpanded and clampNote
 *   are the composer's notice flags, written by boot, draft and send, and
 *   each has its own dismiss action.
 * - mod ('⌘' or 'Ctrl') is detected once at boot for the shortcut hints.
 */
'use client';

import { create } from 'zustand';
import { uid } from '../lib/storage';
import type { Toast } from '../types';

export type ModelBarPopover = 'model' | 'tools' | 'params' | null;
/* which chat or folder the system prompt editor is open for */
export type SystemPromptTarget = { kind: 'chat' | 'folder'; id: string };
export type ConfirmRequest = {
  title: string;
  body?: string;
  confirmLabel?: string;
  /* destructive actions get the red button */
  danger?: boolean;
};
/* one-line prompt answered with text (null = cancelled) */
export type TextRequest = {
  id: string;
  title: string;
  label?: string;
  initial: string;
  confirmLabel?: string;
};

type UIState = {
  booted: boolean;
  stageVisible: boolean;
  /* true while checking session on mount */
  authLoading: boolean;
  /* true when session is confirmed */
  isAuthenticated: boolean;
  context: 'new' | string; // 'new' = home
  palette: boolean;
  help: boolean;
  modelBarPopover: ModelBarPopover;
  devOpen: boolean;
  sending: boolean;
  pendingNav: string | null;
  draftNotice: boolean;
  longPaste: boolean;
  noToolsNote: boolean;
  noticesExpanded: boolean;
  clampNote: string | null;
  toasts: Toast[];
  mod: '⌘' | 'Ctrl';
  systemPromptFor: SystemPromptTarget | null;
  /* tool waiting on the enable confirm dialog */
  confirmToolFor: string | null;
  /* open confirm modal; answered through `confirm()`'s promise */
  confirm: ConfirmRequest | null;
  /* open text prompt; answered through `askText()`'s promise */
  textPrompt: TextRequest | null;
  /* chat whose model the chat-model dialog is picking, or null when it is closed */
  chatModelPicker: string | null;
};

export const useUIStore = create<UIState>()(() => ({
  booted: false,
  stageVisible: false,
  authLoading: true,
  isAuthenticated: false,
  context: 'new',
  palette: false,
  help: false,
  modelBarPopover: null,
  devOpen: false,
  sending: false,
  pendingNav: null,
  draftNotice: false,
  longPaste: false,
  noToolsNote: false,
  noticesExpanded: false,
  clampNote: null,
  toasts: [],
  mod: '⌘',
  systemPromptFor: null,
  confirmToolFor: null,
  confirm: null,
  textPrompt: null,
  chatModelPicker: null,
}));

const set = useUIStore.setState;
const get = useUIStore.getState;

/* kept out of state; only one confirm or prompt is open at a time */
let resolveConfirm: ((ok: boolean) => void) | null = null;
let resolveText: ((value: string | null) => void) | null = null;

export const uiActions = {
  setAuthState(loading: boolean, authenticated: boolean) {
    set({ authLoading: loading, isAuthenticated: authenticated });
  },
  setPalette(open: boolean) {
    set({ palette: open });
  },
  setHelp(open: boolean) {
    set({ help: open });
  },
  /* lives here rather than in the sidebar row, which unmounts when virtualized away */
  editSystemPrompt(target: SystemPromptTarget | null) {
    set({ systemPromptFor: target });
  },
  /** opens the confirm modal; resolves false on cancel, esc or when replaced by another confirm */
  confirm(req: ConfirmRequest): Promise<boolean> {
    resolveConfirm?.(false);
    set({ confirm: req });
    return new Promise((resolve) => {
      resolveConfirm = resolve;
    });
  },
  answerConfirm(ok: boolean) {
    resolveConfirm?.(ok);
    resolveConfirm = null;
    set({ confirm: null });
  },
  /** opens a one-line prompt; resolves the trimmed text, or null on cancel, esc or when replaced */
  askText(req: Omit<TextRequest, 'id'>): Promise<string | null> {
    resolveText?.(null);
    set({ textPrompt: { ...req, id: uid() } });
    return new Promise((resolve) => {
      resolveText = resolve;
    });
  },
  answerText(value: string | null) {
    resolveText?.(value);
    resolveText = null;
    set({ textPrompt: null });
  },
  closeToolConfirm() {
    set({ confirmToolFor: null });
  },
  /** opens the chat-model dialog: picks one chat's model without moving the new-chat default */
  openChatModelPicker(chatId: string) {
    set({ chatModelPicker: chatId });
  },
  closeChatModelPicker() {
    set({ chatModelPicker: null });
  },
  openModelBarPopover(which: Exclude<ModelBarPopover, null>) {
    /* §7.4 only one model/tool-bar popover at a time — instant swap */
    set({ modelBarPopover: get().modelBarPopover === which ? null : which });
  },
  closeModelBarPopover(restore: boolean) {
    const which = get().modelBarPopover;
    set({ modelBarPopover: null });
    if (restore && which) {
      document
        .querySelector<HTMLElement>(`[data-mpb-trigger="${which}"]`)
        ?.focus();
    }
  },
  dismissClampNote() {
    set({ clampNote: null });
  },
  dismissLongPaste() {
    set({ longPaste: false });
  },
  setNoticesExpanded(v: boolean) {
    set({ noticesExpanded: v });
  },
  setDevOpen(v: boolean) {
    set({ devOpen: v });
  },
  toast(text: string, level: Toast['level'] = 'info') {
    const id = uid();
    set({ toasts: [...get().toasts, { id, text, level }] });
    setTimeout(() => uiActions.dismissToast(id), 3500);
  },
  dismissToast(id: string) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  navigateTo(path: string) {
    set({ pendingNav: path });
  },
  clearPendingNav() {
    set({ pendingNav: null });
  },
  setContext(id: string) {
    if (get().context !== id) set({ context: id });
  },
};

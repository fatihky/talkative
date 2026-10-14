/*
 * useChatsStore / chatsActions — the chat list behind the sidebar: chat
 * summaries, the filter text, classification spinners and the home
 * suggestions feed.
 *
 * Business logic:
 * - server-derived, mirrored to localStorage 'cache.chats' by every
 *   setChatItems write, which is what boot shows before the fetch lands.
 * - order is fixed at write time: pinned chats first by pinnedAt desc,
 *   then everyone by createdAt (falling back to updatedAt) desc — the
 *   sidebar only groups the list it's given.
 * - delete, move, rename, pin and system-prompt edits are optimistic: the
 *   list is patched first, the request follows, and a rejection restores
 *   the previous list and raises an error toast.
 * - deleteChat also forgets the chat's per-chat tool selection and routes
 *   away — to the folder the chat was filed in, or home.
 * - move and system-prompt writes no-op when nothing would change, and a
 *   blank system prompt means cleared (undefined locally, null upstream),
 *   matching the server.
 * - classifying marks the chats whose title/tags are being generated after
 *   the first send; the sidebar row shows a spinner for them.
 * - suggestions belong to the home screen but live here: boot refills them
 *   after the chats land, and an empty list collapses the chips.
 * - useRecentModelIds derives the three models carrying the most messages
 *   across all chats, which the home screen offers as a "recent" row.
 */
'use client';

import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { chatsApi } from '../lib/api';
import { LS, uid } from '../lib/storage';
import type { ChatSummary, Suggestion } from '../types';
import { draftActions, forgetChatTools } from './draft';
import { uiActions } from './ui';

type ChatsState = {
  items: ChatSummary[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  filter: string;
  classifying: Record<string, boolean>;
  suggestions: Suggestion[];
};

export const useChatsStore = create<ChatsState>()(() => ({
  items: [],
  status: 'idle',
  filter: '',
  classifying: {},
  suggestions: [],
}));

const set = useChatsStore.setState;
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'error');
const get = useChatsStore.getState;

/* pinned chats float above unpinned ones, newest pinned first, then by recency */
const byCreatedAtDesc = (a: ChatSummary, b: ChatSummary) => {
  const pa = a.pinnedAt ?? 0;
  const pb = b.pinnedAt ?? 0;
  if (pa !== pb) return pb - pa;
  return (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt);
};

export const setChatItems = (items: ChatSummary[]) => {
  const sorted = [...items].sort(byCreatedAtDesc);
  set({ items: sorted });
  LS.set('cache.chats', sorted);
};

export const setClassifying = (chatId: string, on: boolean) =>
  set({ classifying: { ...get().classifying, [chatId]: on } });

export const recentModelIds = (items: ChatSummary[]): string[] => {
  const count = new Map<string, number>();
  for (const c of items)
    count.set(c.modelId, (count.get(c.modelId) ?? 0) + c.messageCount);
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id]) => id);
};

export const useRecentModelIds = () =>
  useChatsStore(useShallow((s) => recentModelIds(s.items)));

export const chatsActions = {
  setChatFilter(filter: string) {
    set({ filter });
  },
  /* optimistic; the previous list comes back if the server refuses */
  deleteChat(id: string) {
    const prev = get().items;
    const folderId = prev.find((c) => c.id === id)?.folderId;
    forgetChatTools(id);
    setChatItems(prev.filter((c) => c.id !== id));
    uiActions.navigateTo(folderId ? `/folder/${folderId}` : '/');
    chatsApi.remove(id).catch((e: unknown) => {
      setChatItems(prev);
      uiActions.toast(`Delete failed — ${errorText(e)}`, 'error');
    });
  },
  moveChat(id: string, folderId: string | null) {
    const prev = get().items;
    if ((prev.find((c) => c.id === id)?.folderId ?? null) === folderId) return;
    setChatItems(
      prev.map((c) =>
        c.id === id ? { ...c, folderId: folderId ?? undefined } : c,
      ),
    );
    chatsApi.patch(id, { folderId }).catch((e: unknown) => {
      setChatItems(prev);
      uiActions.toast(`Move failed — ${errorText(e)}`, 'error');
    });
  },
  renameChat(id: string, title: string) {
    const prev = get().items;
    setChatItems(prev.map((c) => (c.id === id ? { ...c, title } : c)));
    chatsApi.patch(id, { title }).catch((e: unknown) => {
      setChatItems(prev);
      uiActions.toast(`Rename failed — ${errorText(e)}`, 'error');
    });
  },
  pinChat(id: string, pinned: boolean) {
    const prev = get().items;
    setChatItems(
      prev.map((c) =>
        c.id === id ? { ...c, pinnedAt: pinned ? Date.now() : undefined } : c,
      ),
    );
    chatsApi.patch(id, { pinned }).catch((e: unknown) => {
      setChatItems(prev);
      uiActions.toast(
        `${pinned ? 'Pin' : 'Unpin'} failed — ${errorText(e)}`,
        'error',
      );
    });
  },
  /** stages another chat as a `chat:` attachment carrying its id, inlined as a transcript on send */
  attachChat(id: string) {
    const c = get().items.find((x) => x.id === id);
    if (!c) return;
    draftActions.addAttachments([
      { id: uid(), kind: 'chat', name: `chat: ${c.title}`, chatId: c.id },
    ]);
  },
  /* blank clears it, matching the server */
  setChatSystemPrompt(id: string, text: string) {
    const prev = get().items;
    const systemPrompt = text.trim() === '' ? undefined : text;
    if (prev.find((c) => c.id === id)?.systemPrompt === systemPrompt) return;
    setChatItems(prev.map((c) => (c.id === id ? { ...c, systemPrompt } : c)));
    chatsApi
      .patch(id, { systemPrompt: systemPrompt ?? null })
      .catch((e: unknown) => {
        setChatItems(prev);
        uiActions.toast(
          `Saving system prompt failed — ${errorText(e)}`,
          'error',
        );
      });
  },
};

/*
 * useFoldersStore / foldersActions — the sidebar's folder tree: the
 * folders themselves, their load status, which ones are open, and which
 * one is in rename mode.
 *
 * Business logic:
 * - server-derived and cached: every list write goes through
 *   setFolderItems, which sorts case-insensitively by name and mirrors to
 *   localStorage 'cache.folders', while `expanded` mirrors to
 *   'folders.expanded' so the tree reopens the same after a reload. boot
 *   seeds both.
 * - all mutations are optimistic with rollback: the local list changes
 *   first, the request follows, and a rejection restores the previous list
 *   plus an error toast.
 * - createFolder mints the id client-side so the new row can enter rename
 *   mode straight away, expands the parent it was created in, and clears
 *   the chat filter that would otherwise hide the row and its name field.
 * - rename and system-prompt writes no-op when nothing would change, and a
 *   blank system prompt clears it (undefined locally, null upstream).
 * - moveFolder refuses to move a folder into itself or its own subtree —
 *   isWithin walks parents, bounded by the item count so a corrupt cache
 *   can't spin — and expands the new parent; folderPath renders the
 *   "Parent / Child" labels the menus use.
 * - deleteFolder mirrors the server: subfolders and filed chats are
 *   re-parented to the deleted folder's parent rather than vanishing, and
 *   a failure rolls back both the folder and the chat list.
 * - folders only shape the sidebar, so a failed load neither gates the
 *   boot stage nor discards cached rows.
 */
'use client';

import { create } from 'zustand';
import { foldersApi } from '../lib/api';
import { LS, uuid } from '../lib/storage';
import type { Folder } from '../types';
import { setChatItems, useChatsStore } from './chats';
import { uiActions } from './ui';

type FoldersState = {
  items: Folder[];
  status: 'idle' | 'loading' | 'ready' | 'error';
  /* folder id → open; persisted so the tree looks the same after reload */
  expanded: Record<string, boolean>;
  /* a freshly created folder opens straight into its name field */
  renamingId: string | null;
};

export const useFoldersStore = create<FoldersState>()(() => ({
  items: [],
  status: 'idle',
  expanded: {},
  renamingId: null,
}));

const set = useFoldersStore.setState;
const get = useFoldersStore.getState;
const errorText = (e: unknown) => (e instanceof Error ? e.message : 'error');
const byName = (a: Folder, b: Folder) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

export const setFolderItems = (items: Folder[]) => {
  const sorted = [...items].sort(byName);
  set({ items: sorted });
  LS.set('cache.folders', sorted);
};

const setExpanded = (expanded: Record<string, boolean>) => {
  set({ expanded });
  LS.set('folders.expanded', expanded);
};

/** true when `id` is `ancestor` or sits somewhere beneath it */
export const isWithin = (
  items: Folder[],
  id: string | null,
  ancestor: string,
): boolean => {
  const parentOf = new Map(items.map((f) => [f.id, f.parentId]));
  /* bounded walk so a corrupt cache can't spin forever */
  for (let cur = id, n = 0; cur !== null && n <= items.length; n++) {
    if (cur === ancestor) return true;
    cur = parentOf.get(cur) ?? null;
  }
  return false;
};

/** "Parent / Child" label for menus */
export const folderPath = (items: Folder[], id: string): string => {
  const byId = new Map(items.map((f) => [f.id, f]));
  const parts: string[] = [];
  for (
    let f = byId.get(id);
    f && parts.length <= items.length;
    f = f.parentId ? byId.get(f.parentId) : undefined
  )
    parts.unshift(f.name);
  return parts.join(' / ');
};

export const foldersActions = {
  toggleFolder(id: string, open?: boolean) {
    const { expanded } = get();
    setExpanded({ ...expanded, [id]: open ?? !expanded[id] });
  },
  setRenamingFolder(id: string | null) {
    set({ renamingId: id });
  },
  /* optimistic with a client-minted id, so the row can enter rename mode immediately */
  createFolder(parentId: string | null = null, name = 'New folder') {
    const folder: Folder = {
      id: uuid(),
      name,
      parentId,
      createdAt: Date.now(),
    };
    const prev = get().items;
    /* a filter would hide the new row and its name field */
    useChatsStore.setState({ filter: '' });
    setFolderItems([...prev, folder]);
    if (parentId) foldersActions.toggleFolder(parentId, true);
    set({ renamingId: folder.id });
    foldersApi.create(folder).catch((e: unknown) => {
      setFolderItems(get().items.filter((f) => f.id !== folder.id));
      uiActions.toast(`Create folder failed — ${errorText(e)}`, 'error');
    });
    return folder.id;
  },
  renameFolder(id: string, name: string) {
    const prev = get().items;
    const cur = prev.find((f) => f.id === id);
    if (!cur || cur.name === name) return;
    setFolderItems(prev.map((f) => (f.id === id ? { ...f, name } : f)));
    foldersApi.patch(id, { name }).catch((e: unknown) => {
      setFolderItems(prev);
      uiActions.toast(`Rename failed — ${errorText(e)}`, 'error');
    });
  },
  /** resolves true once stored, false when the write failed and the list was rolled back */
  setFolderSystemPrompt(id: string, text: string): Promise<boolean> {
    const prev = get().items;
    const systemPrompt = text.trim() === '' ? undefined : text;
    if (prev.find((f) => f.id === id)?.systemPrompt === systemPrompt)
      return Promise.resolve(true);
    setFolderItems(prev.map((f) => (f.id === id ? { ...f, systemPrompt } : f)));
    return foldersApi.patch(id, { systemPrompt: systemPrompt ?? null }).then(
      () => true,
      (e: unknown) => {
        setFolderItems(prev);
        uiActions.toast(
          `Saving system prompt failed — ${errorText(e)}`,
          'error',
        );
        return false;
      },
    );
  },
  moveFolder(id: string, parentId: string | null) {
    const prev = get().items;
    const cur = prev.find((f) => f.id === id);
    if (!cur || cur.parentId === parentId) return;
    if (isWithin(prev, parentId, id)) {
      uiActions.toast('A folder can’t be moved into itself', 'warn');
      return;
    }
    setFolderItems(prev.map((f) => (f.id === id ? { ...f, parentId } : f)));
    if (parentId) foldersActions.toggleFolder(parentId, true);
    foldersApi.patch(id, { parentId }).catch((e: unknown) => {
      setFolderItems(prev);
      uiActions.toast(`Move failed — ${errorText(e)}`, 'error');
    });
  },
  /* mirrors the server: subfolders and chats move up to the deleted folder's parent */
  deleteFolder(id: string) {
    const prev = get().items;
    const prevChats = useChatsStore.getState().items;
    const cur = prev.find((f) => f.id === id);
    if (!cur) return;
    const up = cur.parentId ?? undefined;
    setFolderItems(
      prev
        .filter((f) => f.id !== id)
        .map((f) => (f.parentId === id ? { ...f, parentId: cur.parentId } : f)),
    );
    setChatItems(
      prevChats.map((c) => (c.folderId === id ? { ...c, folderId: up } : c)),
    );
    foldersApi.remove(id).catch((e: unknown) => {
      setFolderItems(prev);
      setChatItems(prevChats);
      uiActions.toast(`Delete folder failed — ${errorText(e)}`, 'error');
    });
  },
};

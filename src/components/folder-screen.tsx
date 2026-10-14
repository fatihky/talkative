/*
 * FolderScreen — /folder/<id> page: a new chat pre-filed into a folder.
 *
 * Business logic:
 * - Clicking a folder name lands here; the chevron still just expands or
 *   collapses the tree, so a folder is never "opened" as a chat.
 * - On mount it switches context to `new`, resets the draft and records
 *   the folder as pending, so the first message sent from this page
 *   creates a chat filed into that folder (optimistic folderId, patched
 *   once the chat exists). Going home clears the pending folder again.
 * - Lists the six newest chats filed directly in this folder — exact
 *   folderId match, no descendants — newest first, falling back to
 *   updatedAt when a chat has no createdAt; the list hides when empty.
 * - An unknown folder id renders the generic "Folder" heading and no
 *   latest chats rather than an error; rows navigate to their chat.
 */
'use client';

import { useEffect } from 'react';
import { useParams_UNSTABLE } from 'waku/router/client';
import { timeAgo } from '../lib/format';
import { I } from '../lib/icons';
import { actions, useChatsStore, useFoldersStore } from '../stores';
import { setPendingFolder } from '../stores/draft';
import type { ChatSummary } from '../types';

/** the newest chats filed directly in `folderId`, newest first */
const latestChats = (items: ChatSummary[], folderId: string, limit = 6) =>
  items
    .filter((c) => c.folderId === folderId)
    .sort((a, b) => (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt))
    .slice(0, limit);

export function FolderScreen() {
  const params = useParams_UNSTABLE({ from: '/folder/[slug]' });
  const folderId = params?.slug ?? '';
  const folder = useFoldersStore(
    (s) => s.items.find((f) => f.id === folderId) ?? null,
  );
  const chats = useChatsStore((s) => s.items);

  /* the composer files any new chat sent from here into this folder */
  useEffect(() => {
    if (folderId === '') return;
    actions.setContext('new');
    actions.resetDraft();
    setPendingFolder(folderId);
  }, [folderId]);

  const latest = latestChats(chats, folderId);

  return (
    <main className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 pt-[min(18vh,140px)] pb-6 sm:px-6">
      <div className="mx-auto flex w-full max-w-[640px] flex-col">
        <div className="flex items-center gap-2">
          <I n="folder" s={18} className="shrink-0 text-[var(--accent)]" />
          <h1 className="min-w-0 truncate text-[20px] font-semibold leading-[1.35] text-[var(--text)]">
            {folder?.name ?? 'Folder'}
          </h1>
        </div>
        <p className="mt-2 max-w-[460px] text-[13px] leading-[1.55] text-[var(--text-2)]">
          Starting a new chat in this folder. Anything you send here is filed
          into it automatically.
        </p>

        {latest.length > 0 && (
          <section className="mt-6" aria-label="Latest chats">
            <div className="sec-label mb-1.5">Latest chats</div>
            <ul className="flex flex-col">
              {latest.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => actions.navigateTo(`/c/${c.id}`)}
                    className="flex h-9 w-full items-center gap-2 rounded-[6px] px-2 text-left hover:bg-[var(--sunken)]"
                  >
                    <I n="chat" s={13} className="shrink-0 muted" />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-[500]">
                      {c.title}
                    </span>
                    <span className="num shrink-0 text-[11px] muted">
                      {timeAgo(c.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}

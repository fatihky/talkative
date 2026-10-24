/*
 * chatActionsMenu — the ⋯ menu items for one chat, shared by the sidebar
 * row and the thread header.
 *
 * Business logic:
 * - One list feeds both places so they can't drift: rename, pin/unpin,
 *   system prompt, move to…, export as text, and delete behind a confirm
 *   dialog.
 * - Rename differs by surface: the sidebar starts its inline editor and
 *   the thread header opens a prompt dialog, so the label comes in.
 * - "Move to…" is offered only when at least one folder exists, and it
 *   reports back instead of navigating, because the move picker is a
 *   separate menu the caller keeps open (the actions menu's onClose only
 *   clears its own state). On phones it reads "Move to… (or drag)" so the
 *   quicker drag gesture is discoverable.
 * - Delete confirms with the chat's title, then forgets the chat (the
 *   store's deleteChat routes away from thread view).
 */
'use client';

import type { MenuItem } from '../lib/popover';
import { actions } from '../stores';
import type { ChatSummary } from '../types';

export function chatActionsMenu({
  chat,
  hasFolders,
  renameLabel = 'Rename',
  moveHint = false,
  onRename,
  onMove,
}: {
  chat: Pick<ChatSummary, 'id' | 'title' | 'pinnedAt'> &
    Partial<Pick<ChatSummary, 'systemPrompt'>>;
  hasFolders: boolean;
  renameLabel?: string;
  /* small screens: mention that the row can be dragged into a folder */
  moveHint?: boolean;
  onRename: () => void;
  onMove: () => void;
}): MenuItem[] {
  /* the system prompt only matters once the chat exists */
  const promptReady = 'systemPrompt' in chat;
  return [
    { label: renameLabel, onSelect: onRename },
    {
      label: chat.pinnedAt ? 'Unpin' : 'Pin to top',
      onSelect: () => actions.pinChat(chat.id, !chat.pinnedAt),
    },
    ...(promptReady
      ? [
          {
            label: chat.systemPrompt ? 'Edit system prompt…' : 'System prompt…',
            onSelect: () =>
              actions.editSystemPrompt({ kind: 'chat', id: chat.id }),
          },
        ]
      : []),
    ...(hasFolders
      ? [
          {
            label: moveHint ? 'Move to… (or drag)' : 'Move to…',
            onSelect: onMove,
          },
        ]
      : []),
    {
      label: 'Export as text',
      onSelect: () => actions.exportChat(chat.id),
    },
    {
      label: 'Delete chat',
      onSelect: async () => {
        const ok = await actions.confirm({
          title: `Delete “${chat.title}”?`,
          body: 'This removes the chat and all of its messages. This can’t be undone.',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (ok) actions.deleteChat(chat.id);
      },
      danger: true,
    },
  ];
}

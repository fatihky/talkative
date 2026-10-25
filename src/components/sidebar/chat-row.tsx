/*
 * ChatRow — one chat entry in the sidebar list.
 *
 * Business logic:
 * - The title is a link to /c/<id>, so a plain click routes in place while a
 *   modified or middle click opens the chat in a new tab; double-click starts
 *   an inline rename that commits on Enter/blur (empty input keeps the old
 *   title) and cancels on Escape.
 * - A spinner shows while the chat is streaming a reply or classifying;
 *   a pin icon marks pinned chats, and a small gear marks chats carrying
 *   their own system prompt, so an overridden chat is visible at a glance.
 * - Actions menu: rename, pin/unpin, system prompt, export as text, and
 *   delete gated behind a confirm dialog — the same list the thread
 *   header shows, built by chatActionsMenu.
 * - "Move to…" is offered only when at least one folder exists; picking it
 *   swaps to the move menu, which the actions menu's onClose leaves open.
 * - Draggable for filing into folders, disabled while renaming; on touch
 *   screens Draggable picks up a drag from the same press instead.
 */
'use client';

import { useRef, useState } from 'react';
import { Link } from 'waku';
import { I } from '../../lib/icons';
import { Menu, Tip } from '../../lib/popover';
import {
  actions,
  useChatsStore,
  useFoldersStore,
  useLayoutStore,
  useThreadsStore,
} from '../../stores';
import type { ChatSummary } from '../../types';
import { chatActionsMenu } from '../chat-actions';
import { DRAG_MIME, type Drag, indent } from './drag';
import { MoveMenu } from './move-menu';
import { Draggable } from './touch-drag';

export function ChatRow({
  chat,
  depth,
  active,
  renaming,
  setRenaming,
  onDrag,
}: {
  chat: ChatSummary;
  depth: number;
  active: boolean;
  renaming: boolean;
  setRenaming: (v: boolean) => void;
  onDrag: (d: Drag | null) => void;
}) {
  const [menu, setMenu] = useState<'actions' | 'move' | null>(null);
  const menuAnchor = useRef<HTMLButtonElement | null>(null);
  const [title, setTitle] = useState(chat.title);
  const hasFolders = useFoldersStore((s) => s.items.length > 0);
  const mobile = useLayoutStore((s) => s.vw < 768);
  const classifying = useChatsStore((s) => s.classifying[chat.id] === true);
  const generating = useThreadsStore(
    (s) => s.threads[chat.id]?.streaming === true,
  );

  return (
    <Draggable
      drag={{ kind: 'chat', id: chat.id }}
      className={`group relative flex h-10 w-full items-center gap-2 border-l-2 pr-1 text-left ${
        active
          ? 'border-l-[var(--accent)] bg-[var(--accent-weak)]'
          : 'border-l-transparent hover:bg-[var(--sunken)]'
      }`}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: virtualized rows live inside a positioned spacer div */}
      <div
        className="flex size-full items-center gap-2"
        style={{ paddingLeft: indent(depth) }}
        role="listitem"
        draggable={!renaming}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_MIME, chat.id);
          e.dataTransfer.effectAllowed = 'move';
          onDrag({ kind: 'chat', id: chat.id });
        }}
        onDragEnd={() => onDrag(null)}
      >
        {renaming ? (
          <input
            ref={(el) => el?.focus()}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => {
              actions.renameChat(chat.id, title.trim() || chat.title);
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setRenaming(false);
            }}
            className="h-6 min-w-0 flex-1 rounded-[4px] border border-[var(--accent)] bg-[var(--raised)] px-1 text-[13px] outline-none"
            aria-label="Rename chat"
          />
        ) : (
          <Link
            to={`/c/${chat.id}`}
            onClick={() => actions.setMobileNav(false)}
            onDoubleClick={() => {
              setTitle(chat.title);
              setRenaming(true);
            }}
            className="block min-w-0 flex-1 text-left no-underline"
            aria-label={`Open chat ${chat.title}`}
          >
            <span className="flex items-center gap-1.5 truncate text-[13px] font-[500] leading-tight">
              {(generating || classifying) && (
                <span className="block size-3 shrink-0 animate-spin rounded-full border-2 border-[var(--text)] border-t-transparent" />
              )}
              {chat.pinnedAt && (
                <I n="pin" s={11} className="shrink-0 text-[var(--text-3)]" />
              )}
              <span className="truncate">{chat.title}</span>
              {chat.systemPrompt && (
                <Tip label="This chat has its own system prompt" side="top">
                  <span className="shrink-0 text-[var(--text-3)]">
                    <I n="sliders" s={10} />
                  </span>
                </Tip>
              )}
            </span>
          </Link>
        )}
        <button
          ref={menuAnchor}
          type="button"
          aria-label={`Actions for ${chat.title}`}
          aria-expanded={menu !== null}
          onClick={() => setMenu((m) => (m === 'actions' ? null : 'actions'))}
          className="ctl-icon absolute right-1 top-1/2 hidden size-6 -translate-y-1/2 border-transparent bg-transparent text-[var(--text-3)] group-hover:flex hover:bg-[var(--border)] max-md:flex"
        >
          <I n="dots" s={14} />
        </button>
        <Menu
          open={menu === 'actions'}
          anchor={menuAnchor}
          onClose={() => setMenu((m) => (m === 'actions' ? null : m))}
          items={chatActionsMenu({
            chat,
            hasFolders,
            /* on phones a drag is the quicker way in, so say so */
            moveHint: mobile,
            onRename: () => setRenaming(true),
            /* the actions menu's onClose only clears 'actions', so the picker stays up */
            onMove: () => setMenu('move'),
          })}
        />
        <MoveMenu
          open={menu === 'move'}
          anchor={menuAnchor}
          onClose={() => setMenu(null)}
          current={chat.folderId ?? null}
          onPick={(folderId) => actions.moveChat(chat.id, folderId)}
        />
      </div>
    </Draggable>
  );
}

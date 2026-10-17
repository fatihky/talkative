/*
 * FolderRow — one folder in the sidebar tree.
 *
 * Business logic:
 * - The chevron expands/collapses the subtree; clicking the name routes
 *   to /folder/<id> (a new-chat page that files sends into the folder)
 *   and closes the mobile drawer.
 * - Double-click renames inline: Enter/blur commits (empty keeps the old
 *   name), Escape cancels; the renaming id lives in the folders store so
 *   only one row can rename at a time, and text is selected once on entry.
 * - Actions menu: new subfolder, rename, system prompt, move to…, delete
 *   (delete asks first; the folder's subfolders and chats move up a level).
 * - The move picker excludes the folder itself and its own subtree.
 * - Acts as both drag source (folder move) and drop target for dragged
 *   chats/folders, highlighting while a valid drop hovers it.
 */
'use client';

import { type DragEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'waku';
import { I } from '../../lib/icons';
import { Menu } from '../../lib/popover';
import { actions, useFoldersStore } from '../../stores';
import type { Folder } from '../../types';
import { type Drag, DRAG_MIME, indent } from './drag';
import { MoveMenu } from './move-menu';

export function FolderRow({
  folder,
  depth,
  count,
  open,
  dropping,
  onDrag,
  onDropHover,
  onDropHere,
}: {
  folder: Folder;
  depth: number;
  count: number;
  open: boolean;
  dropping: boolean;
  onDrag: (d: Drag | null) => void;
  onDropHover: (e: DragEvent<HTMLDivElement>) => void;
  onDropHere: (e: DragEvent<HTMLDivElement>) => void;
}) {
  const renaming = useFoldersStore((s) => s.renamingId === folder.id);
  const [menu, setMenu] = useState<'actions' | 'move' | null>(null);
  const menuAnchor = useRef<HTMLButtonElement | null>(null);
  const [name, setName] = useState(folder.name);
  const input = useRef<HTMLInputElement | null>(null);

  /* select once on entering rename; a callback ref would reselect on every keystroke */
  useEffect(() => {
    if (renaming) input.current?.select();
  }, [renaming]);

  return (
    // biome-ignore lint/a11y/useSemanticElements: virtualized rows live inside a positioned spacer div
    <div
      className={`group relative flex size-full items-center gap-1.5 border-l-2 pr-1 ${
        dropping
          ? 'border-l-[var(--accent)] bg-[var(--accent-weak)]'
          : 'border-l-transparent hover:bg-[var(--sunken)]'
      }`}
      style={{ paddingLeft: indent(depth) - 2 }}
      role="listitem"
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_MIME, folder.id);
        e.dataTransfer.effectAllowed = 'move';
        onDrag({ kind: 'folder', id: folder.id });
      }}
      onDragEnd={() => onDrag(null)}
      onDragOver={onDropHover}
      onDrop={onDropHere}
    >
      {renaming ? (
        <>
          <I n="folder" s={13} className="shrink-0 muted" />
          <input
            ref={input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              actions.renameFolder(folder.id, name.trim() || folder.name);
              actions.setRenamingFolder(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') {
                setName(folder.name);
                actions.setRenamingFolder(null);
              }
            }}
            className="h-6 min-w-0 flex-1 rounded-[4px] border border-[var(--accent)] bg-[var(--raised)] px-1 text-[13px] outline-none"
            aria-label="Rename folder"
          />
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={() => actions.toggleFolder(folder.id)}
            aria-label={open ? 'Collapse folder' : 'Expand folder'}
            className="flex h-full shrink-0 items-center pr-0.5"
          >
            <I
              n={open ? 'chevron-down' : 'chevron-right'}
              s={11}
              className="shrink-0 muted"
            />
          </button>
          <Link
            to={`/folder/${folder.id}`}
            onClick={() => actions.setMobileNav(false)}
            onDoubleClick={() => {
              setName(folder.name);
              actions.setRenamingFolder(folder.id);
            }}
            aria-label={`Folder ${folder.name}`}
            className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left no-underline"
          >
            <I n="folder" s={13} className="shrink-0 text-[var(--text-2)]" />
            <span className="truncate text-[13px] font-[500]">
              {folder.name}
            </span>
            <span className="num shrink-0 text-[11px] muted group-hover:invisible">
              {count}
            </span>
          </Link>
        </>
      )}
      <button
        ref={menuAnchor}
        type="button"
        aria-label={`Actions for folder ${folder.name}`}
        aria-expanded={menu !== null}
        onClick={() => setMenu('actions')}
        className="ctl-icon absolute right-1 top-1/2 hidden size-6 -translate-y-1/2 border-transparent bg-transparent text-[var(--text-3)] group-hover:flex hover:bg-[var(--border)]"
      >
        <I n="dots" s={14} />
      </button>
      <Menu
        open={menu === 'actions'}
        anchor={menuAnchor}
        onClose={() => setMenu((m) => (m === 'actions' ? null : m))}
        items={[
          {
            label: 'New subfolder',
            onSelect: () => actions.createFolder(folder.id),
          },
          {
            label: 'Rename',
            onSelect: () => {
              setName(folder.name);
              actions.setRenamingFolder(folder.id);
            },
          },
          {
            label: folder.systemPrompt
              ? 'Edit system prompt…'
              : 'System prompt…',
            onSelect: () =>
              actions.editSystemPrompt({ kind: 'folder', id: folder.id }),
          },
          {
            label: 'Move to…',
            onSelect: () => setMenu('move'),
          },
          { sep: true },
          {
            label: 'Delete folder',
            onSelect: async () => {
              const ok = await actions.confirm({
                title: `Delete “${folder.name}”?`,
                body: 'This deletes the folder. Its subfolders and chats are kept and moved up a level. This can’t be undone.',
                confirmLabel: 'Delete',
                danger: true,
              });
              if (ok) actions.deleteFolder(folder.id);
            },
            danger: true,
          },
        ]}
      />
      <MoveMenu
        open={menu === 'move'}
        anchor={menuAnchor}
        onClose={() => setMenu(null)}
        current={folder.parentId}
        exclude={folder.id}
        onPick={(parentId) => actions.moveFolder(folder.id, parentId)}
      />
    </div>
  );
}

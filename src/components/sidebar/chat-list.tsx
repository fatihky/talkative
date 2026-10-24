/*
 * ChatList — the sidebar's virtualized tree of folders and chats.
 *
 * Business logic:
 * - Flattens the folder tree, filed chats, a PINNED section, and recency
 *   groups (TODAY…OLDER) into one absolutely positioned list; rows are
 *   windowed only past 50 items.
 * - Recency groups from PREVIOUS 7 DAYS down start collapsed; every group
 *   and PINNED toggle via its header.
 * - The filter matches chat titles and tags; folders whose name matches
 *   force their subtree open, and folders with no surviving row are pruned.
 * - Pinned chats sort by pinnedAt desc and appear only under PINNED, never
 *   inside folders or recency groups.
 * - Unfiled chats sort by createdAt desc; chats or folders pointing at an
 *   unknown folder id fall back to the top level.
 * - Drag & drop re-files chats and folders (a folder can't drop into its
 *   own subtree); dropping on a filed chat files into that chat's folder.
 *   Desktop uses HTML5 drag & drop; touch screens fall back to pointer
 *   drags through TouchDragProvider, since mobile never fires dragstart.
 * - Shows skeletons while loading, an empty state at zero chats+folders,
 *   and a "no matches" note when the filter empties the list.
 */
'use client';

import { type DragEvent, useEffect, useMemo, useRef, useState } from 'react';
import { type RecencyGroup, recencyGroup } from '../../lib/format';
import { I } from '../../lib/icons';
import {
  actions,
  isWithin,
  useChatsStore,
  useFoldersStore,
} from '../../stores';
import type { ChatSummary, Folder } from '../../types';
import { Skeleton } from '../../ui/primitives';
import { ChatRow } from './chat-row';
import type { Drag } from './drag';
import { FolderRow } from './folder-row';
import { ListZone, TouchDragProvider } from './touch-drag';

const GROUPS: RecencyGroup[] = [
  'TODAY',
  'YESTERDAY',
  'PREVIOUS 7 DAYS',
  'PREVIOUS 30 DAYS',
  'OLDER',
];

const pinnedOf = (c: ChatSummary) => !!c.pinnedAt;

type Flat =
  | {
      type: 'header';
      group: RecencyGroup | 'PINNED';
      count: number;
      collapsed: boolean;
    }
  | {
      type: 'folder';
      folder: Folder;
      depth: number;
      count: number;
      open: boolean;
    }
  | { type: 'item'; chat: ChatSummary; depth: number }
  | { type: 'empty' };

const HEADER_H = 24;
const FOLDER_H = 30;
const ROW_H = 40;

const heightOf = (f: Flat) =>
  f.type === 'header'
    ? HEADER_H
    : f.type === 'folder'
      ? FOLDER_H
      : f.type === 'item'
        ? ROW_H
        : 140;

/* index of the row containing pixel `y` */
const rowAt = (offsets: number[], y: number) => {
  let lo = 0;
  let hi = offsets.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((offsets[mid] ?? 0) <= y) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
};

export function ChatList({
  items,
  activeId,
}: {
  items: ChatSummary[];
  activeId: string | null;
}) {
  const filter = useChatsStore((s) => s.filter);
  const status = useChatsStore((s) => s.status);
  const folders = useFoldersStore((s) => s.items);
  const expanded = useFoldersStore((s) => s.expanded);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({
    'PREVIOUS 7 DAYS': true,
    'PREVIOUS 30 DAYS': true,
    OLDER: true,
  });
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  /* folder id, 'root' for the unfiled area, or null */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);

  const flat = useMemo<Flat[]>(() => {
    if (status === 'loading' || status === 'idle') return [];
    if (items.length === 0 && folders.length === 0) return [{ type: 'empty' }];
    const f = filter.trim().toLowerCase();
    const matches = (c: ChatSummary) =>
      f === '' ||
      c.title.toLowerCase().includes(f) ||
      c.tags.some((t) => t.includes(f));

    /* folders or chats pointing at a folder we don't know (yet) fall back to the top level */
    const known = new Set(folders.map((x) => x.id));
    const subfolders = new Map<string | null, Folder[]>();
    for (const x of folders) {
      const p = x.parentId && known.has(x.parentId) ? x.parentId : null;
      subfolders.set(p, [...(subfolders.get(p) ?? []), x]);
    }
    const chatsIn = new Map<string, ChatSummary[]>();
    const unfiled: ChatSummary[] = [];
    const byCreatedAtDesc = (a: ChatSummary, b: ChatSummary) =>
      (b.createdAt ?? b.updatedAt) - (a.createdAt ?? a.updatedAt);
    for (const c of items) {
      if (c.folderId && known.has(c.folderId)) {
        const arr = chatsIn.get(c.folderId) ?? [];
        arr.push(c);
        arr.sort(byCreatedAtDesc);
        chatsIn.set(c.folderId, arr);
      } else unfiled.push(c);
    }
    unfiled.sort(byCreatedAtDesc);

    const byPinnedDesc = (a: ChatSummary, b: ChatSummary) =>
      (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
    const pinned = items.filter(pinnedOf).sort(byPinnedDesc);

    const out: Flat[] = [];
    /* returns [matching chat count, whether any row in the subtree survived the filter] */
    const walk = (
      parent: string | null,
      depth: number,
      showAll: boolean,
    ): [number, boolean] => {
      let total = 0;
      let kept = false;
      for (const folder of subfolders.get(parent) ?? []) {
        const all =
          showAll || (f !== '' && folder.name.toLowerCase().includes(f));
        const open = f !== '' || expanded[folder.id] === true;
        const at = out.length;
        out.push({ type: 'folder', folder, depth, count: 0, open });
        let [count, keep] = walk(folder.id, depth + 1, all);
        for (const c of chatsIn.get(folder.id) ?? []) {
          if (!all && !matches(c)) continue;
          if (pinnedOf(c)) continue;
          count++;
          out.push({ type: 'item', chat: c, depth: depth + 1 });
        }
        keep = keep || count > 0 || all || f === '';
        if (!keep) {
          out.length = at;
          continue;
        }
        if (!open) out.length = at + 1;
        out[at] = { type: 'folder', folder, depth, count, open };
        total += count;
        kept = true;
      }
      return [total, kept];
    };
    walk(null, 0, false);

    const pinnedArr = pinned.filter(matches);
    if (pinnedArr.length > 0) {
      const col = collapsed.PINNED === true;
      out.push({
        type: 'header',
        group: 'PINNED',
        count: pinnedArr.length,
        collapsed: col,
      });
      if (!col)
        for (const c of pinnedArr)
          out.push({ type: 'item', chat: c, depth: 0 });
    }

    for (const g of GROUPS) {
      const arr = unfiled.filter(
        (c) =>
          !pinnedOf(c) &&
          recencyGroup(c.createdAt ?? c.updatedAt) === g &&
          matches(c),
      );
      if (arr.length === 0) continue;
      const col = collapsed[g] === true;
      out.push({ type: 'header', group: g, count: arr.length, collapsed: col });
      if (!col)
        for (const c of arr) out.push({ type: 'item', chat: c, depth: 0 });
    }
    return out;
  }, [items, folders, expanded, filter, collapsed, status]);

  /* heights */
  const offsets = useMemo(() => {
    const o: number[] = [0];
    for (const f of flat) o.push((o[o.length - 1] ?? 0) + heightOf(f));
    return o;
  }, [flat]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const total = offsets[offsets.length - 1] ?? 0;
  /* windowing only required above 50 items */
  const startRaw =
    flat.length > 50 ? Math.max(0, rowAt(offsets, scrollTop) - 8) : 0;
  const endRaw =
    flat.length > 50
      ? Math.min(flat.length, rowAt(offsets, scrollTop + viewH) + 9)
      : flat.length;
  const visible = flat.slice(startRaw, endRaw);

  const canDrop = (target: string | null) => {
    if (!drag) return false;
    if (drag.kind === 'chat')
      return (items.find((c) => c.id === drag.id)?.folderId ?? null) !== target;
    const cur = folders.find((x) => x.id === drag.id);
    return (
      !!cur && cur.parentId !== target && !isWithin(folders, target, drag.id)
    );
  };
  const hover = (target: string | null) => (e: DragEvent<HTMLElement>) => {
    e.stopPropagation();
    if (!canDrop(target)) {
      setDropTarget(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(target ?? 'root');
  };
  const drop = (target: string | null) => (e: DragEvent<HTMLElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (drag && canDrop(target)) file(drag, target);
    setDrag(null);
    setDropTarget(null);
  };
  const onDrag = (d: Drag | null) => {
    setDrag(d);
    if (!d) setDropTarget(null);
  };
  const file = (d: Drag, target: string | null) => {
    if (d.kind === 'chat') actions.moveChat(d.id, target);
    else actions.moveFolder(d.id, target);
  };

  if (status === 'loading' || status === 'idle') {
    return (
      <div
        className="flex flex-col gap-2 px-3 py-2"
        role="status"
        aria-label="Loading chats"
        aria-busy="true"
      >
        {Array.from({ length: 6 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list
          <Skeleton key={i} w="100%" h={32} r={6} />
        ))}
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: virtualized list with a positioned spacer div
    <div
      ref={scroller}
      role="list"
      aria-label="Chats"
      className={`scroll-thin min-h-0 flex-1 overflow-y-auto ${
        dropTarget === 'root' ? 'bg-[var(--accent-weak)]' : ''
      }`}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onDragOver={hover(null)}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setDropTarget(null);
      }}
      onDrop={drop(null)}
    >
      <TouchDragProvider canDrop={canDrop} onDrop={file}>
        <ListZone>
          {flat.length === 0 && items.length > 0 && (
            <div className="px-3 py-6 text-center text-[12px] muted">
              No chats match “{filter}”.
            </div>
          )}
          <div style={{ height: total, position: 'relative' }}>
            {visible.map((f, k) => {
              const idx = startRaw + k;
              const top = offsets[idx] ?? 0;
              if (f.type === 'empty')
                return (
                  <ChatListEmptyState
                    key="empty"
                    style={{ position: 'absolute', top, left: 0, right: 0 }}
                  />
                );
              if (f.type === 'header')
                return (
                  <button
                    key={f.group}
                    type="button"
                    style={{
                      position: 'absolute',
                      top,
                      left: 0,
                      right: 0,
                      height: HEADER_H,
                    }}
                    className="flex items-center gap-1 px-3 hover:bg-[var(--sunken)]"
                    aria-expanded={!f.collapsed}
                    onClick={() =>
                      setCollapsed((c) => ({ ...c, [f.group]: !f.collapsed }))
                    }
                  >
                    <I
                      n={f.collapsed ? 'chevron-right' : 'chevron-down'}
                      s={11}
                      className="muted"
                    />
                    <span className="sec-label num">
                      {f.group} ({f.count})
                    </span>
                  </button>
                );
              if (f.type === 'folder')
                return (
                  <div
                    key={`f-${f.folder.id}`}
                    style={{
                      position: 'absolute',
                      top,
                      left: 0,
                      right: 0,
                      height: FOLDER_H,
                    }}
                  >
                    <FolderRow
                      folder={f.folder}
                      depth={f.depth}
                      count={f.count}
                      open={f.open}
                      dropping={dropTarget === f.folder.id}
                      onDrag={onDrag}
                      onDropHover={hover(f.folder.id)}
                      onDropHere={drop(f.folder.id)}
                    />
                  </div>
                );
              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: drop target only; the row inside carries the interactions
                <div
                  key={f.chat.id}
                  style={{
                    position: 'absolute',
                    top,
                    left: 0,
                    right: 0,
                    height: ROW_H,
                  }}
                  /* dropping onto a filed chat files into the same folder */
                  onDragOver={hover(
                    f.depth > 0 ? (f.chat.folderId ?? null) : null,
                  )}
                  onDrop={drop(f.depth > 0 ? (f.chat.folderId ?? null) : null)}
                >
                  <ChatRow
                    chat={f.chat}
                    depth={f.depth}
                    active={f.chat.id === activeId}
                    renaming={renamingId === f.chat.id}
                    setRenaming={(v) => setRenamingId(v ? f.chat.id : null)}
                    onDrag={onDrag}
                  />
                </div>
              );
            })}
          </div>
        </ListZone>
      </TouchDragProvider>
    </div>
  );
}

function ChatListEmptyState({ style }: { style?: React.CSSProperties }) {
  return (
    <div
      className="flex flex-col items-center gap-2 px-6 py-8 text-center"
      style={style}
    >
      <I n="chat" s={32} className="text-[var(--text-3)]" w={1.2} />
      <div className="text-[13px] font-medium">No chats yet</div>
      <div className="max-w-[200px] text-[12px] muted">
        Send your first message below — it becomes a chat automatically.
      </div>
      <button
        type="button"
        className="ctl-primary mt-1 h-7"
        onClick={() => actions.focusComposer()}
      >
        Create your first chat
      </button>
    </div>
  );
}

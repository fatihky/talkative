/*
 * MoveMenu — "Move to…" folder picker shared by chat and folder rows
 * and the thread header's ⋯ menu.
 *
 * Business logic:
 * - Targets are all folders except the current one and, when moving a
 *   folder, its own subtree (a folder can't contain itself).
 * - Entries are labeled with the full folder path and sorted
 *   alphabetically.
 * - "Top level" (unfile) is offered only when the item is currently filed.
 * - Stays closed when there are no possible targets.
 */
'use client';

import { type RefObject, useMemo } from 'react';
import { Menu, type MenuItem } from '../../lib/popover';
import { folderPath, isWithin, useFoldersStore } from '../../stores';

/** "Move to…" picker shared by chat and folder rows */
export function MoveMenu({
  open,
  anchor,
  onClose,
  current,
  exclude,
  onPick,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  current: string | null;
  /* a folder can't go into itself or its own subtree */
  exclude?: string | undefined;
  onPick: (folderId: string | null) => void;
}) {
  const folders = useFoldersStore((s) => s.items);
  const items = useMemo<MenuItem[]>(() => {
    const targets = folders
      .filter(
        (f) =>
          f.id !== current && !(exclude && isWithin(folders, f.id, exclude)),
      )
      .map((f) => ({ id: f.id, label: folderPath(folders, f.id) }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const out: MenuItem[] = [];
    if (current !== null)
      out.push({ label: 'Top level', onSelect: () => onPick(null) });
    if (out.length > 0 && targets.length > 0) out.push({ sep: true });
    for (const t of targets)
      out.push({ label: t.label, onSelect: () => onPick(t.id) });
    return out;
  }, [folders, current, exclude, onPick]);
  return (
    <Menu
      open={open && items.length > 0}
      anchor={anchor}
      onClose={onClose}
      items={items}
      width={220}
    />
  );
}

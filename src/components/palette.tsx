/*
 * CommandPalette — mod+K launcher across chats, messages, notes and
 * settings; the shell suspends every other shortcut while it's open.
 *
 * Business logic:
 * - An empty query shows shortcuts, not search: the 6 newest chats, 3
 *   notes and 2 settings entries.
 * - A query searches chat titles, chat first prompts (as "Messages"),
 *   note titles and bodies, and settings labels, always grouped in that
 *   order and capped per group (8/12/5/5) so one kind can't crowd out the
 *   rest. Message hits come from two places: first prompts of the 24
 *   newest chats (local) and a debounced GET /api/search that matches
 *   message content across every branch, so a message parked on a dead
 *   branch still surfaces.
 * - Opening a chat goes through the caller's onOpenChat with a full path
 *   (client-side routing, folder paths included); notes navigate via the
 *   store.
 * - Settings entries do a hard `location.href` load and fall back to
 *   /settings when an entry has no route of its own.
 * - Running a row closes the palette first, so navigation always lands on
 *   a clean shell; Esc or a scrim click closes without running anything.
 * - Arrow keys move the highlight (also on hover), Enter runs it, and the
 *   highlight is clamped whenever the result list shrinks.
 */
'use client';

import type { ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { searchApi } from '../lib/api';
import { I } from '../lib/icons';
import { SETTINGS_ITEMS } from '../lib/mock';
import { actions, useChatsStore, useNotesStore, useUIStore } from '../stores';
import { Kbd } from '../ui/primitives';

type Row = {
  id: string;
  group: string;
  label: string;
  sub?: string;
  icon: string;
  run: () => void;
};

export function CommandPalette({
  onOpenChat,
}: {
  onOpenChat: (path: string) => void;
}) {
  const open = useUIStore((s) => s.palette);
  const chats = useChatsStore((s) => s.items);
  const notes = useNotesStore((s) => s.notes);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  /* server-side message hits for the current query; nulls out while loading */
  const [hits, setHits] = useState<
    | {
        id: string;
        chatId: string;
        chatTitle: string;
        role: string;
        snippet: string;
      }[]
    | null
  >(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setIdx(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  /* debounced server search across every message of every branch */
  useEffect(() => {
    const t = q.trim();
    if (t === '') {
      setHits(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchApi
        .search(t)
        .then((res) => {
          if (!cancelled) setHits(res.messages);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  const rows = useMemo<Row[]>(() => {
    const t = q.trim().toLowerCase();
    const out: Row[] = [];
    if (t === '') {
      for (const c of chats.slice(0, 6))
        out.push({
          id: c.id,
          group: 'Chats',
          label: c.title,
          icon: 'chat',
          run: () => onOpenChat(`/c/${c.id}`),
        });
      for (const n of notes.slice(0, 3))
        out.push({
          id: n.id,
          group: 'Notes',
          label: n.title,
          icon: 'note',
          run: () => actions.navigateTo(`/notes/${n.id}`),
        });
      for (const s of SETTINGS_ITEMS.slice(0, 2))
        out.push({
          id: s.id,
          group: 'Settings',
          label: s.label,
          icon: 'settings',
          run: () => (location.href = 'to' in s ? s.to : '/settings'),
        });
      return out;
    }
    const match = (s: string) => s.toLowerCase().includes(t);
    /* §12 — order: Chats → Messages → Notes → Settings */
    for (const c of chats.filter((c) => match(c.title)).slice(0, 8))
      out.push({
        id: c.id,
        group: 'Chats',
        label: c.title,
        sub: c.modelId,
        icon: 'chat',
        run: () => onOpenChat(`/c/${c.id}`),
      });
    for (const c of chats.slice(0, 24)) {
      const p = c.firstPrompt;
      if (p && match(p))
        out.push({
          id: `m-${c.id}`,
          group: 'Messages',
          label: p.slice(0, 60),
          sub: `in ${c.title}`,
          icon: 'note',
          run: () => onOpenChat(`/c/${c.id}`),
        });
    }
    for (const h of hits ?? []) {
      out.push({
        id: `m-${h.id}`,
        group: 'Messages',
        label: h.snippet,
        sub: `in ${h.chatTitle}`,
        icon: 'note',
        run: () => onOpenChat(`/c/${h.chatId}`),
      });
    }
    for (const n of notes.filter((n) => match(n.title) || match(n.text)))
      out.push({
        id: n.id,
        group: 'Notes',
        label: n.title,
        sub: n.text.slice(0, 48),
        icon: 'note',
        run: () => actions.navigateTo(`/notes/${n.id}`),
      });
    for (const s of SETTINGS_ITEMS.filter((s) => match(s.label)))
      out.push({
        id: s.id,
        group: 'Settings',
        label: s.label,
        icon: 'settings',
        run: () => (location.href = 'to' in s ? s.to : '/settings'),
      });
    const cap: Record<string, number> = {
      Chats: 8,
      Messages: 12,
      Notes: 5,
      Settings: 5,
    };
    const seen: Record<string, number> = {};
    return out.filter((r) => {
      seen[r.group] = (seen[r.group] ?? 0) + 1;
      return (seen[r.group] ?? 0) <= (cap[r.group] ?? 5);
    });
  }, [q, chats, notes, hits, onOpenChat]);

  useEffect(
    () => setIdx((i) => Math.min(i, Math.max(0, rows.length - 1))),
    [rows.length],
  );

  if (!open) return null;

  const run = (r: Row) => {
    actions.setPalette(false);
    r.run();
  };
  let lastGroup = '';
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center"
      style={{ background: 'var(--scrim)' }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) actions.setPalette(false);
      }}
    >
      <div
        className="pop mt-[14vh] flex max-h-[62vh] w-full max-w-[540px] flex-col"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3">
          <I n="search" s={15} className="muted shrink-0" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIdx((i) => Math.min(rows.length - 1, i + 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIdx((i) => Math.max(0, i - 1));
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                const r = rows[idx];
                if (r) run(r);
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                actions.setPalette(false);
              }
            }}
            placeholder="Search chats, messages, notes, settings…"
            aria-label="Search"
            className="h-10 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-[var(--text-3)]"
          />
          <Kbd>esc</Kbd>
        </div>
        <div
          ref={listRef}
          role="listbox"
          aria-label="Results"
          tabIndex={-1}
          className="scroll-thin min-h-0 flex-1 overflow-y-auto py-1 outline-none"
        >
          {rows.length === 0 && (
            <div className="px-3 py-6 text-center text-[12px] muted">
              No results for “{q}”.
            </div>
          )}
          {rows.map((r, i) => {
            const header = r.group !== lastGroup ? r.group : null;
            lastGroup = r.group;
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: the same id can appear in several groups
              <div key={r.id + i}>
                {header && <GroupHeader>{header}</GroupHeader>}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === idx}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => run(r)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] ${
                    i === idx ? 'bg-[var(--sunken)]' : ''
                  }`}
                >
                  <I n={r.icon} s={13} className="muted shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{r.label}</span>
                  {r.sub && (
                    <span className="num max-w-[160px] shrink-0 truncate text-[11px] muted">
                      {r.sub}
                    </span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function GroupHeader({ children }: { children: ReactNode }) {
  return <div className="sec-label px-3 pb-1 pt-2.5">{children}</div>;
}

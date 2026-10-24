/*
 * HelpDialog — keyboard shortcut reference modal.
 *
 * Business logic:
 * - Opened by `?` through the shell binding and shown over the app; it
 *   renders only while the ui store's `help` flag is set.
 * - The list is hand-maintained here and must stay in sync with the real
 *   bindings in shell.tsx and composer.tsx — it documents them, it does
 *   not register them.
 * - Modifier labels come from the ui store's `mod` (⌘ or Ctrl, detected at
 *   boot) so one list reads correctly on every platform.
 * - Esc or `?` closes it, as does a backdrop press landing on the scrim
 *   itself; focus moves into the dialog on open so its own key handler
 *   gets the event.
 */
'use client';

import { useEffect, useRef } from 'react';
import { I } from '../lib/icons';
import { actions, useUIStore } from '../stores';
import { Kbd } from '../ui/primitives';

type Row = { keys: string[]; label: string };

/* keep in sync with the bindings in shell.tsx and composer.tsx */
const groups = (mod: string): { title: string; rows: Row[] }[] => [
  {
    title: 'General',
    rows: [
      { keys: [`${mod}K`], label: 'Search & commands' },
      { keys: [`${mod}F`], label: 'Find in chat' },
      { keys: [`${mod}N`], label: 'New chat' },
      { keys: [`${mod}B`], label: 'Toggle sidebar' },
      { keys: [`${mod}.`], label: 'Toggle right panel' },
      { keys: ['?'], label: 'Show this help' },
      { keys: ['esc'], label: 'Close panel or dialog' },
    ],
  },
  {
    title: 'Composer',
    rows: [
      { keys: [`${mod}/`], label: 'Focus composer' },
      { keys: ['⏎'], label: 'Send' },
      { keys: ['⇧⏎'], label: 'Newline' },
      { keys: ['Ctrl+T'], label: 'Tools' },
      { keys: ['Ctrl+⇧P'], label: 'Parameters' },
    ],
  },
];

export function HelpDialog() {
  const open = useUIStore((s) => s.help);
  const mod = useUIStore((s) => s.mod);
  const box = useRef<HTMLDivElement | null>(null);
  const close = () => actions.setHelp(false);

  /* focus the dialog so its Esc handler gets the key */
  useEffect(() => {
    if (open) box.current?.focus();
  }, [open]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center px-4"
      style={{ background: 'var(--scrim)' }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={box}
        tabIndex={-1}
        className="pop mt-[12vh] flex max-h-[76vh] w-full max-w-[440px] flex-col outline-none"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === '?') {
            e.preventDefault();
            e.stopPropagation();
            close();
          }
        }}
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
          <I n="help" s={13} className="muted shrink-0" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-[500]">
            Keyboard shortcuts
          </span>
          <Kbd>esc</Kbd>
        </div>
        <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-3">
          {groups(mod).map((g) => (
            <section key={g.title}>
              <div className="sec-label mb-1.5">{g.title}</div>
              <ul className="flex flex-col">
                {g.rows.map((r) => (
                  <li
                    key={r.label}
                    className="flex h-7 items-center justify-between gap-3 text-[12px]"
                  >
                    <span className="text-[var(--text-2)]">{r.label}</span>
                    <span className="flex gap-1">
                      {r.keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

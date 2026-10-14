/*
 * ToolConfirmDialog — explicit consent before a privacy-sensitive tool is
 * granted.
 *
 * Business logic:
 * - Only tools that carry a `confirm` note in lib/tools can trigger it
 *   (chat_search today: it reads every other chat of the user and sends
 *   what it finds to that chat's model provider).
 * - Anything else never prompts: with no confirm note the dialog renders
 *   nothing and the grant goes through directly.
 * - Enable calls setToolGrant(id, true, confirmed) — that confirmed flag
 *   is what stops the store from re-opening this same dialog in a loop.
 * - Focus lands on Cancel, so a stray Enter declines rather than grants;
 *   Esc or a scrim click closes without granting anything.
 * - The dialog is keyed by tool id, so the warning text always belongs to
 *   the tool actually being asked about.
 */
'use client';

import { useEffect, useRef } from 'react';
import { I } from '../lib/icons';
import { TOOLS } from '../lib/tools';
import { actions, useUIStore } from '../stores';
import { Kbd } from '../ui/primitives';

/** asks before granting a tool that carries a `confirm` note (see lib/tools) */
export function ToolConfirmDialog() {
  const id = useUIStore((s) => s.confirmToolFor);
  const tool = id ? TOOLS.find((t) => t.id === id) : undefined;
  if (!tool?.confirm) return null;
  return <Confirm key={tool.id} label={tool.label} text={tool.confirm} />;
}

function Confirm({ label, text }: { label: string; text: string }) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const id = useUIStore((s) => s.confirmToolFor);
  const close = () => actions.closeToolConfirm();
  const enable = () => {
    if (id) actions.setToolGrant(id, true, true);
    close();
  };

  /* focus lands on cancel so a stray enter doesn't grant the tool */
  useEffect(() => cancelRef.current?.focus(), []);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center px-4"
      style={{ background: 'var(--scrim)' }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="pop mt-[18vh] flex w-full max-w-[440px] flex-col"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="tool-confirm-title"
        aria-describedby="tool-confirm-body"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            close();
          }
        }}
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
          <I n="alert" s={13} className="muted shrink-0" />
          <span
            id="tool-confirm-title"
            className="min-w-0 flex-1 truncate text-[13px] font-[500]"
          >
            Enable {label}?
          </span>
          <Kbd>esc</Kbd>
        </div>
        <p
          id="tool-confirm-body"
          className="p-3 text-[13px] leading-[1.6] text-[var(--text-2)]"
        >
          {text}
        </p>
        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-3 py-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={close}
            className="ctl-ghost h-7 rounded-[6px] px-2 text-[12px]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={enable}
            className="ctl-primary h-7 rounded-[6px] px-3 text-[12px]"
          >
            Enable
          </button>
        </div>
      </div>
    </div>
  );
}

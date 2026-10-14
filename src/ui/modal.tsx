/*
 * Modal — the app's one dialog surface: scrim, titled panel, optional footer.
 *
 * Business logic:
 * - Backs every confirmation the app asks for (delete a chat or note,
 *   publish an artifact, consent to a tool) via ConfirmDialog; closing it
 *   is a "no", so `actions.confirm()` resolves false on esc or backdrop.
 * - Dismisses on esc and on a backdrop press that lands on the scrim
 *   itself, never on one that started inside the panel.
 * - Esc stops propagating so the shell's document-level esc handler can't
 *   also tear down the panel underneath this one.
 * - The panel takes focus on mount only when no child claimed it first, so
 *   esc always works while a footer button (cancel) keeps focus priority.
 * - Header and footer are optional chrome; the body scrolls inside a 76vh
 *   cap and is only advertised to AT when children exist.
 */
'use client';

import { type ReactNode, useEffect, useId, useRef } from 'react';
import { I } from '../lib/icons';
import { Kbd } from './primitives';

/** scrim + centered panel with a titled header; closes on esc and backdrop press */
export function Modal({
  title,
  icon,
  onClose,
  width = 440,
  children,
  footer,
}: {
  title: ReactNode;
  icon?: string;
  onClose: () => void;
  width?: number;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  /* focus the panel so esc works, unless a child already grabbed focus */
  useEffect(() => {
    if (!box.current?.contains(document.activeElement)) box.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center px-4"
      style={{ background: 'var(--scrim)' }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={box}
        tabIndex={-1}
        className="pop mt-[18vh] flex max-h-[76vh] w-full flex-col outline-none"
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={children ? bodyId : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            /* keep shell's document-level esc from also closing a panel */
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2">
          {icon && <I n={icon} s={13} className="muted shrink-0" />}
          <span
            id={titleId}
            className="min-w-0 flex-1 truncate text-[13px] font-[500]"
          >
            {title}
          </span>
          <Kbd>esc</Kbd>
        </div>
        {children && (
          <div
            id={bodyId}
            className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3 text-[13px] leading-[1.6] text-[var(--text-2)]"
          >
            {children}
          </div>
        )}
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-3 py-2">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

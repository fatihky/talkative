/* IconButton — square icon-only button; its tip doubles as the aria-label. */
'use client';

import type { ButtonHTMLAttributes } from 'react';
import { I } from '../../lib/icons';
import { Tip } from '../../lib/popover';

export function IconButton({
  icon,
  tip,
  size = 28,
  ghost = false,
  active = false,
  disabled = false,
  onClick,
  ...rest
}: {
  icon: string;
  tip?: string | undefined;
  size?: number;
  ghost?: boolean;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'>) {
  const btn = (
    <button
      type="button"
      aria-label={tip}
      aria-pressed={active || undefined}
      disabled={disabled}
      onClick={onClick}
      style={{ width: size, height: size }}
      className={`inline-flex shrink-0 items-center justify-center rounded-[6px] border transition-colors focus-visible:outline-none ${
        disabled
          ? 'cursor-not-allowed border-transparent text-[var(--text-3)] opacity-60'
          : ghost
            ? `border-transparent text-[var(--text-2)] hover:bg-[var(--sunken)] hover:text-[var(--text)] active:border-[var(--border-strong)] ${active ? 'bg-[var(--sunken)] text-[var(--text)]' : ''}`
            : `ctl ${active ? 'border-[var(--accent)] bg-[var(--accent-weak)]' : ''}`
      }`}
      {...rest}
    >
      <I n={icon} s={size >= 28 ? 15 : 13} />
    </button>
  );
  return tip ? <Tip label={tip}>{btn}</Tip> : btn;
}

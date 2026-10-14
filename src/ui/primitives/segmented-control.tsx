/* SegmentedControl — arrow-key radiogroup; Tip explains a disabled state. */
'use client';

import { useState } from 'react';
import { Tip } from '../../lib/popover';

export function SegmentedControl({
  value,
  options,
  onChange,
  disabled,
  disabledReason,
  ariaLabel,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  disabled: boolean;
  disabledReason?: string | undefined;
  ariaLabel: string;
}) {
  const [announce, setAnnounce] = useState('');
  const idx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  const onKey = (e: React.KeyboardEvent) => {
    if (disabled) return;
    let next = idx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown')
      next = (idx + 1) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp')
      next = (idx - 1 + options.length) % options.length;
    else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      const v = options[idx]?.value;
      if (v !== undefined) onChange(v);
      return;
    } else return;
    e.preventDefault();
    const v = options[next]?.value;
    if (v === undefined) return;
    setAnnounce(v);
    if (!disabled) onChange(v);
  };

  const body = (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={onKey}
      className={`flex h-7 shrink-0 items-center gap-0.5 overflow-hidden rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] p-0.5 ${
        disabled ? 'cursor-not-allowed opacity-60' : ''
      }`}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: styled segmented control built from buttons
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            tabIndex={-1}
            onMouseDown={() => !disabled && onChange(o.value)}
            className={`h-full rounded-[4px] px-1.5 text-[11px] leading-none transition-colors ${
              selected
                ? 'bg-[var(--raised)] font-medium text-[var(--text)] shadow-[inset_0_0_0_1px_var(--border-strong)]'
                : 'text-[var(--text-3)] hover:text-[var(--text-2)]'
            } ${announce === o.value ? 'ring-1 ring-[var(--accent)]' : ''}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
  return disabled && disabledReason ? (
    <Tip label={disabledReason}>{body}</Tip>
  ) : (
    body
  );
}

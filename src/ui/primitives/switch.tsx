/* Switch — boolean toggle rendered as a role="switch" button. */
'use client';

import { Tip } from '../../lib/popover';

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  disabledReason,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
}) {
  const el = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`group flex items-center gap-2 ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <span
        className={`relative inline-block h-[16px] w-[26px] shrink-0 rounded-[4px] border transition-colors ${
          checked
            ? 'border-[var(--accent)] bg-[var(--accent)]'
            : 'border-[var(--border-strong)] bg-[var(--sunken)]'
        }`}
      >
        <span
          className="absolute top-[2px] block size-[10px] rounded-[2px] bg-[var(--text-inv)] transition-left"
          style={{ left: checked ? 13 : 2 }}
        />
      </span>
    </button>
  );
  return disabled && disabledReason ? (
    <Tip label={disabledReason}>{el}</Tip>
  ) : (
    el
  );
}

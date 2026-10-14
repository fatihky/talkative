/* Kbd — shortcut hint chip; onAccent stays legible over any accent hue. */
'use client';

import type { ReactNode } from 'react';

export function Kbd({
  children,
  onAccent = false,
}: {
  children: ReactNode;
  onAccent?: boolean;
}) {
  return (
    <kbd
      className={
        onAccent
          ? /* translucent so it reads on any accent hue in both themes */
            'num inline-flex h-[18px] shrink-0 items-center rounded-[4px] border border-[color-mix(in_srgb,var(--text-inv)_25%,transparent)] bg-[color-mix(in_srgb,var(--text-inv)_18%,transparent)] px-[5px] text-[11px] font-normal leading-none text-[var(--text-inv)]'
          : 'num inline-flex h-[18px] shrink-0 items-center rounded-[4px] border border-[var(--border-strong)] bg-[var(--sunken)] px-[5px] text-[11px] font-normal leading-none text-[var(--text-2)]'
      }
    >
      {children}
    </kbd>
  );
}

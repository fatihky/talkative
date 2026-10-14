/* SecLabel — small muted heading that opens a settings section. */
'use client';

import type { ReactNode } from 'react';

export function SecLabel({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`sec-label ${className}`}>{children}</div>;
}

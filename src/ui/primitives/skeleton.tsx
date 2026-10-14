/* Skeleton — pulsing placeholder sized to the content it stands in for. */
'use client';

export function Skeleton({
  w,
  h = 12,
  r = 4,
  className = '',
}: {
  w: number | string;
  h?: number;
  r?: number;
  className?: string;
}) {
  return (
    <span
      className={`inline-block shrink-0 animate-pulse bg-[var(--sunken)] ${className}`}
      style={{ width: w, height: h, borderRadius: r }}
      aria-hidden="true"
    />
  );
}

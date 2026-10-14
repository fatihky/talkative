/* Meter — context-usage bar turning warn at 70% and danger at 90%. */
'use client';

export function Meter({
  used,
  max,
  width = 60,
}: {
  used: number;
  max: number;
  width?: number;
}) {
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0;
  const color =
    pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warn)' : 'var(--accent)';
  return (
    <span
      className="inline-block shrink-0 overflow-hidden rounded-[2px] bg-[var(--sunken)]"
      style={{ width, height: 4 }}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Context usage"
    >
      <span
        className="block h-full"
        style={{ width: `${pct}%`, background: color }}
      />
    </span>
  );
}

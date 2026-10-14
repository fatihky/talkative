/* BadgeDot — accent dot pinned to a positioned parent's corner. */
'use client';

export function BadgeDot() {
  return (
    <span
      className="absolute -right-0.5 -top-0.5 block size-[6px] rounded-full bg-[var(--accent)]"
      aria-hidden="true"
    />
  );
}

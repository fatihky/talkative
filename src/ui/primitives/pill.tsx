/*
 * Pill — the handoff's status pill, emitted with its exact classes.
 *
 * The clean-layout handoff styles a pill as `.pill` plus a tone letter
 * (`s` success, `w` warn, `d` danger, `i` info, `a` accent, `g` muted) —
 * see styles.css's "status pills" block. `pulse` adds the `.pulse` dot
 * that ripples while live; `tone` maps the app's semantic names onto the
 * letter classes.
 */
import type { ReactNode } from 'react';

export type PillTone = 'accent' | 'ok' | 'warn' | 'danger' | 'info' | 'muted';

/* tone → handoff letter class */
const TONE: Record<PillTone, string> = {
  accent: 'a',
  ok: 's',
  warn: 'w',
  danger: 'd',
  info: 'i',
  muted: 'g',
};

export function Pill({
  children,
  tone = 'accent',
  pulse = false,
}: {
  children: ReactNode;
  tone?: PillTone;
  pulse?: boolean;
}) {
  return (
    <span className={`pill ${TONE[tone]}`}>
      {pulse && <span className="pulse" aria-hidden="true" />}
      {children}
    </span>
  );
}

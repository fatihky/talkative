/*
 * keyboard — one global keydown listener shared by a stack of named scopes.
 *
 * Business logic:
 * - Client-only hook. The window listener is installed when the first scope
 *   mounts and removed when the last one unmounts, so an app with no scopes
 *   has no key handling at all.
 * - comboOf normalizes an event to `mod+ctrl+alt+shift+key`, lowercased,
 *   with ' ' → 'space'. Meta maps to `mod` and Ctrl stays `ctrl`, so a
 *   `mod+k` binding fires on ⌘K only — a cross-platform Ctrl shortcut needs
 *   its own `ctrl+…` binding, which is why the shell registers both styles.
 * - Bare typing keys are never hijacked: a single-part combo only dispatches
 *   for escape/enter/arrowup/arrowdown, and tab is dropped again right
 *   after so browser focus handling stays intact.
 * - Scopes stack in mount order; the topmost non-suspended scope with a
 *   matching handler wins, the search stops there, and the event is
 *   preventDefault-ed unless the handler already did it.
 * - suspend mutes a single scope (the shell mutes its app shortcuts while
 *   the command palette is open, §7.3); suspendOthers mutes every scope
 *   mounted below the caller's.
 * - The scope object and the returned api are stable refs, and bind replaces
 *   the whole handler map, so callers re-bind on every render.
 * - One consumer today: the shell's `home` scope — mod+k palette, mod+n new
 *   chat, mod+b sidebar, mod+. right panel, ctrl+t tools, ctrl+shift+p
 *   params, mod+/ focus composer.
 */
'use client';

import { useEffect, useRef } from 'react';

export type Combo = string; // normalized: 'mod+k', 'ctrl+shift+p', 'escape', 'enter'

type Handlers = Record<string, (e: KeyboardEvent) => void>;

type Scope = { name: string; handlers: Handlers; suspended: boolean };

const stack: Scope[] = [];
let installed = false;

export const comboOf = (e: KeyboardEvent): string => {
  const parts: string[] = [];
  if (e.metaKey) parts.push('mod');
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  const k = e.key.toLowerCase();
  parts.push(k === ' ' ? 'space' : k);
  return parts.join('+');
};

const onKey = (e: KeyboardEvent) => {
  // never hijack bare typing keys
  const combo = comboOf(e);
  const parts = combo.split('+');
  if (
    parts.length === 1 &&
    !['escape', 'enter', 'tab', 'arrowdown', 'arrowup'].includes(parts[0] ?? '')
  )
    return;
  if (parts.length === 1 && parts[0] === 'tab') return;
  for (let i = stack.length - 1; i >= 0; i--) {
    const s = stack[i];
    if (!s) continue;
    if (s.suspended) continue;
    const fn = s.handlers[combo];
    if (fn) {
      fn(e);
      if (!e.defaultPrevented) e.preventDefault();
      return;
    }
  }
};

const install = () => {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('keydown', onKey);
};
const maybeUninstall = () => {
  if (stack.length === 0 && installed) {
    installed = false;
    window.removeEventListener('keydown', onKey);
  }
};

export type ScopeApi = {
  bind: (handlers: Handlers) => void;
  suspend: (suspended: boolean) => void;
  suspendOthers: (suspended: boolean) => void; // suspend all scopes below this one
};

/**
 * Registers a keyboard scope. Scopes stack: the topmost non-suspended scope
 * whose handler matches wins. `suspendOthers(true)` is used by the command
 * palette to suspend composer bindings while open (§7.3).
 */
export function useKeyboardScope(name: string): ScopeApi {
  const ref = useRef<Scope | null>(null);
  if (!ref.current) {
    ref.current = { name, handlers: {}, suspended: false };
  }
  const scope = ref.current;

  useEffect(() => {
    install();
    stack.push(scope);
    return () => {
      const i = stack.indexOf(scope);
      if (i >= 0) stack.splice(i, 1);
      maybeUninstall();
    };
  }, [scope]);

  const apiRef = useRef<ScopeApi | null>(null);
  if (!apiRef.current) {
    apiRef.current = {
      bind: (h) => {
        scope.handlers = h;
      },
      suspend: (v) => {
        scope.suspended = v;
      },
      suspendOthers: (v) => {
        const i = stack.indexOf(scope);
        stack.forEach((s, j) => {
          if (j < i) s.suspended = v;
        });
      },
    };
  }
  return apiRef.current;
}

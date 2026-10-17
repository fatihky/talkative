/*
 * GlobalStatusBar — slim footer: palette hint, version, state debugger.
 *
 * Business logic:
 * - The old connection/model/tools/cost readouts were deliberately
 *   dropped; what remains is the mod+K palette shortcut and the version.
 * - The version is __APP_VERSION__, inlined from package.json by the
 *   `app-version` vite plugin at build time, so only the number itself
 *   lands in the dist javascript — not package.json's other fields.
 * - The version button opens the §9 state debugger popover, whose goal is
 *   that every designed state is reachable from the UI.
 * - Checkboxes toggle persistent dev flags (offline, degraded, catalog
 *   failure, rate limit, empty chats/suggestions, always-fail send, slow
 *   network).
 * - "go" buttons fire one-shot states: S1 cold boot clears localStorage
 *   and reloads, S12 attaches a ~900KB file to force context overflow,
 *   S13 revokes every tool grant, and S7/no-thinking switch the model.
 */
'use client';

import { useRef } from 'react';
import type { DevFlags } from '../lib/api';
import { Popover } from '../lib/popover';
import { uid } from '../lib/storage';
import { TOOLS } from '../lib/tools';
import { actions, useNetworkStore, useUIStore } from '../stores';
import type { Attachment } from '../types';
import { Kbd } from '../ui/primitives';

export function GlobalStatusBar() {
  const devOpen = useUIStore((s) => s.devOpen);
  const mod = useUIStore((s) => s.mod);
  const devAnchor = useRef<HTMLButtonElement | null>(null);

  return (
    <footer
      role="contentinfo"
      className="num relative z-10 flex h-6 shrink-0 items-center gap-3 overflow-hidden border-t border-[var(--border)] bg-[var(--panel)] px-3 text-[11px] whitespace-nowrap max-md:h-5"
    >
      <span className="ml-auto flex shrink-0 items-center gap-2 text-[var(--text-3)]">
        <button
          type="button"
          aria-label="Open command palette"
          onClick={() => actions.setPalette(true)}
          className="hover:text-[var(--text)]"
        >
          <Kbd>{mod}K</Kbd>
        </button>
        <button
          ref={devAnchor}
          type="button"
          className="hover:text-[var(--text)]"
          aria-expanded={devOpen}
          onClick={() => actions.setDevOpen(!devOpen)}
          aria-label={`Open state debugger (18 designed states) — v${__APP_VERSION__}`}
        >
          v{__APP_VERSION__}
        </button>
      </span>

      <Popover
        open={devOpen}
        anchor={devAnchor}
        onClose={() => actions.setDevOpen(false)}
        placement="top-start"
        width={310}
        z={40}
      >
        <DevDebugger />
      </Popover>
    </footer>
  );
}

/* §9 — every state reachable from the UI */
function DevDebugger() {
  const dev = useNetworkStore((s) => s.dev);
  const rows: {
    label: string;
    key?: keyof DevFlags;
    on?: boolean;
    action?: () => void;
  }[] = [
    {
      label: 'S1 · Cold boot (clear cache & reload)',
      action: () => {
        localStorage.clear();
        location.reload();
      },
    },
    {
      label: 'S6 · Model catalog error',
      key: 'failCatalog',
      on: dev.failCatalog,
    },
    { label: 'S10 · Offline', key: 'simulateOffline', on: dev.simulateOffline },
    { label: 'Degraded connection', key: 'degraded', on: dev.degraded },
    {
      label: 'S11 · serpapi rate-limited',
      key: 'rateLimited',
      on: dev.rateLimited,
    },
    { label: 'S8 · Zero chats', key: 'emptyChats', on: dev.emptyChats },
    {
      label: 'S9 · Zero suggestions',
      key: 'emptySuggestions',
      on: dev.emptySuggestions,
    },
    {
      label: 'S18 · Send always fails (or type [fail])',
      key: 'failSend',
      on: dev.failSend,
    },
    { label: 'Slow network (4×)', key: 'slowNetwork', on: dev.slowNetwork },
    {
      label: 'S7 · Capability-unknown model',
      action: () => actions.setModel('llama-4-maverick'),
    },
    {
      label: 'No-thinking model (claude-haiku-4.5)',
      action: () => actions.setModel('claude-haiku-4.5'),
    },
    {
      label: 'S12 · Force context overflow',
      action: () => {
        const a: Attachment = {
          id: uid(),
          kind: 'file',
          name: 'huge-dump.bin',
          bytes: 900_000,
          mime: 'application/octet-stream',
        };
        actions.addAttachments([a]);
      },
    },
    {
      label: 'S13 · Disable all tools',
      action: () => {
        for (const t of TOOLS) actions.setToolGrant(t.id, false);
      },
    },
  ];
  return (
    <div className="px-3 py-2 text-[12px]">
      <div className="sec-label mb-1">State debugger</div>
      {rows.map((r) => (
        // biome-ignore lint/a11y/noLabelWithoutControl: wraps either a checkbox or a button
        <label
          key={r.label}
          className="flex min-h-[24px] cursor-pointer items-center justify-between gap-2"
        >
          <span className="text-[var(--text-2)]">{r.label}</span>
          {r.key ? (
            <input
              type="checkbox"
              checked={r.on === true}
              onChange={(e) =>
                actions.setDev({ [r.key ?? '']: e.target.checked })
              }
              className="size-3.5 accent-[var(--accent)]"
            />
          ) : (
            <button
              type="button"
              className="ctl h-6 px-2 text-[11px]"
              onClick={r.action}
            >
              go
            </button>
          )}
        </label>
      ))}
    </div>
  );
}

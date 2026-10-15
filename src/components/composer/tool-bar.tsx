/*
 * ToolBar — per-message tool grants and the context meter above the
 * input.
 *
 * Business logic:
 * - grants edited here ride with the next send and are stored on the
 *   user turn, so queued and regenerated replies keep them.
 * - selections are per chat: switching context swaps in that chat's own
 *   picks; edits before a thread's first message update the
 *   account-wide defaults, after it they stay thread-wide.
 * - tools the current model can't run (missing capability) or the
 *   server can't run (unavailable backend) are locked off with a reason
 *   and excluded from the n/available count.
 * - bulk enable never switches on a confirm-gated tool (chat_search
 *   asks first); GitHub tools get their own section and bulk toggles.
 * - the provider select offers only backends reported by GET /api/tools
 *   ('default' hidden) and is locked until the tool is granted.
 * - the chip is inert until model info is ready; Ctrl T opens the
 *   popover.
 * - ContextIndicator meters the estimate — draft, the branch on
 *   screen's history, and tool call args/results — against the model
 *   window: warn at ≥70%, danger at ≥90% or overflow, and the raw used
 *   count alone when the window is unknown.
 */
'use client';

import { useMemo, useRef } from 'react';
import { I } from '../../lib/icons';
import { Popover, Tip } from '../../lib/popover';
import { TOOLS } from '../../lib/tools';
import {
  actions,
  modelDisabledTools,
  useDraftStore,
  useEstimate,
  useLayoutStore,
  useModelsStore,
  useSelectedModel,
  useToolsStore,
  useUIStore,
} from '../../stores';
import type { Tool } from '../../types';
import { Kbd, Meter, Switch } from '../../ui/primitives';

/* github tools get their own section in the popover */
const CORE_TOOLS = TOOLS.filter((t) => !t.id.startsWith('github_'));
const GITHUB_TOOLS = TOOLS.filter((t) => t.id.startsWith('github_'));

/* ── ToolPermissionBar ─────────────────────────────────────────── */

function ToolPermissionBar() {
  const grants = useDraftStore((s) => s.toolGrants);
  const providers = useDraftStore((s) => s.toolProviders);
  const model = useSelectedModel();
  const status = useModelsStore((s) => s.status);
  const open = useUIStore((s) => s.modelBarPopover) === 'tools';
  const anchor = useRef<HTMLButtonElement | null>(null);
  const statuses = useToolsStore((s) => s.items);
  const disabledMap = useMemo(
    () => modelDisabledTools(model, statuses),
    [model, statuses],
  );

  /* only tools usable with the current model count as available or active */
  const available = TOOLS.length - disabledMap.size;
  const n = TOOLS.filter(
    (t) => grants[t.id] === true && !disabledMap.has(t.id),
  ).length;

  const row = (t: Tool) => {
    const off = disabledMap.get(t.id);
    /* once the server answers, only backends with credentials are offered */
    const provs = (statuses[t.id]?.providers ?? t.providers)?.filter(
      (p) => p !== 'default',
    );
    return (
      <div key={t.id} className="flex h-[26px] items-center gap-2">
        <label
          className={`flex min-w-0 flex-1 items-center gap-1.5 ${off ? 'cursor-not-allowed' : 'cursor-pointer'}`}
        >
          <Switch
            checked={grants[t.id] === true}
            disabled={off !== undefined}
            disabledReason={off}
            label={`Grant ${t.label}`}
            onChange={(v) => actions.setToolGrant(t.id, v)}
          />
          <span
            className={`min-w-0 flex-1 truncate text-[13px] ${off ? 'muted' : ''}`}
          >
            {t.label}
          </span>
        </label>
        {provs && provs.length > 0 ? (
          <select
            aria-label={`${t.label} provider`}
            value={
              provs.includes(providers[t.id] ?? '') ? providers[t.id] : provs[0]
            }
            disabled={grants[t.id] !== true}
            onChange={(e) => actions.setToolProvider(t.id, e.target.value)}
            className="h-[22px] max-w-[110px] rounded-[4px] border border-[var(--border)] bg-[var(--raised)] px-1 text-[11px] text-[var(--text-2)] focus-visible:outline-none"
          >
            {provs.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        ) : (
          <span className="w-[64px]" aria-hidden="true" />
        )}
      </div>
    );
  };

  const chip = (
    <button
      ref={anchor}
      data-mpb-trigger="tools"
      type="button"
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={`Tools: ${n} of ${available} enabled`}
      onClick={() =>
        status === 'ready' ? actions.openModelBarPopover('tools') : undefined
      }
      className={`flex shrink-0 items-center gap-0.5 rounded-[4px] text-[11px] ${
        status !== 'ready'
          ? 'cursor-not-allowed text-[var(--text-2)] opacity-60'
          : n === 0
            ? 'text-[var(--text-3)] hover:cursor-pointer hover:text-[var(--text)]'
            : 'text-[var(--text-2)] hover:cursor-pointer hover:text-[var(--text)]'
      }`}
    >
      <I n="wrench" s={11} className="shrink-0" />
      <span className="ml-0.5">Tools</span>
      <span className="num ml-0.5">
        {n}/{available}
      </span>
      <I n="chevron-down" s={10} className="shrink-0 opacity-60" />
    </button>
  );

  return (
    <>
      {status !== 'ready' ? (
        <Tip label="Waiting for model info" side="bottom">
          {chip}
        </Tip>
      ) : n === 0 ? (
        <Tip label="All tools disabled for this message" side="bottom">
          {chip}
        </Tip>
      ) : (
        chip
      )}
      <Popover
        open={open}
        anchor={anchor}
        onClose={(r) => actions.closeModelBarPopover(r)}
        placement="top-start"
        width={340}
        z={40}
      >
        <div className="px-3 pt-2.5 pb-1">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="sec-label min-w-0 truncate">Tools granted</div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                className="ctl h-6 whitespace-nowrap px-2.5 text-[11px]"
                onClick={() => actions.setAllToolGrants(true)}
              >
                Enable all
              </button>
              <button
                type="button"
                className="ctl h-6 whitespace-nowrap px-2.5 text-[11px]"
                onClick={() => actions.setAllToolGrants(false)}
              >
                Disable all
              </button>
            </div>
          </div>
          <div className="flex flex-col">{CORE_TOOLS.map(row)}</div>
          {GITHUB_TOOLS.length > 0 && (
            <div className="mt-2 border-t border-[var(--border)] pt-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <div className="sec-label flex items-center gap-1">
                  <I n="branch" s={12} /> GitHub
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    className="ctl h-6 whitespace-nowrap px-2.5 text-[11px]"
                    onClick={() =>
                      actions.setToolGrants(
                        GITHUB_TOOLS.map((t) => t.id),
                        true,
                      )
                    }
                  >
                    Enable all
                  </button>
                  <button
                    type="button"
                    className="ctl h-6 whitespace-nowrap px-2.5 text-[11px]"
                    onClick={() =>
                      actions.setToolGrants(
                        GITHUB_TOOLS.map((t) => t.id),
                        false,
                      )
                    }
                  >
                    Disable all
                  </button>
                </div>
              </div>
              <div className="flex flex-col">{GITHUB_TOOLS.map(row)}</div>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 pb-1 pt-2 text-[11px] muted">
            <span>Grants are per message by default and revocable.</span>
            <Kbd>Ctrl T</Kbd>
          </div>
        </div>
      </Popover>
    </>
  );
}

/* ── Context size indicator ────────────────────────────────────── */

function ContextIndicator() {
  const est = useEstimate((e) => ({
    used: e.contextUsed,
    window: e.window,
    overflow: e.overflow,
  }));
  const vw = useLayoutStore((s) => s.vw);
  const pct = est.window
    ? Math.min(100, Math.round((est.used / est.window) * 100))
    : 0;
  const color =
    est.overflow || pct >= 90
      ? 'text-[var(--danger)]'
      : pct >= 70
        ? 'text-[var(--warn)]'
        : 'muted';
  const label = est.window
    ? `${fmtK(est.used)} / ${fmtK(est.window)}`
    : `${fmtK(est.used)} / —`;
  const title = est.window
    ? `${est.used.toLocaleString()} / ${est.window.toLocaleString()} tokens`
    : `${est.used.toLocaleString()} tokens, window unknown`;
  if (!est.window) {
    return (
      <div
        className={`num flex shrink-0 items-center gap-2 pl-2 text-[11px] ${color}`}
        role="status"
        aria-label={`Context ${est.used} tokens, window unknown`}
        title={title}
      >
        {label}
      </div>
    );
  }
  return (
    <div
      className={`num flex shrink-0 items-center gap-2 pl-2 text-[11px] ${color}`}
      role="status"
      aria-label={`Context ${est.used} of ${est.window} tokens, ${pct} percent`}
      title={title}
    >
      <span>{label}</span>
      <Meter used={est.used} max={est.window} />
      {vw >= 900 && <span>{pct}%</span>}
    </div>
  );
}

const fmtK = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
      : `${n}`;

/* ── ToolBar ───────────────────────────────────────────────────── */

export function ToolBar() {
  return (
    <div
      className="no-scrollbar flex h-7 shrink-0 items-center gap-1 overflow-x-auto rounded-t-[7px] border-b border-[var(--border)] bg-[var(--panel)] px-2 [mask-image:linear-gradient(to_right,black_calc(100%-20px),transparent_100%)]"
      data-region="tool-bar"
    >
      <ToolPermissionBar />
      <div className="ml-auto shrink-0">
        <ContextIndicator />
      </div>
    </div>
  );
}

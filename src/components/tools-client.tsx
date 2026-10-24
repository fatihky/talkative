/*
 * ToolsClient — the /settings/tools screen for the account-wide default tool
 * permissions.
 *
 * Business logic:
 * - Everything here edits the defaults new chats inherit, never one chat:
 *   the page sets the UI context to 'new', which is what makes the store
 *   commit to the account defaults and save them to tool_preferences.
 *   Per-chat overrides live in the composer's tool bar.
 * - Availability comes from GET /api/tools; an unavailable tool is
 *   greyed out, can't be granted, and its description is replaced by the
 *   reason (no key, no backend configured).
 * - The model-capability half of that check is skipped on purpose —
 *   defaults aren't tied to a model, so a tool a given model can't use is
 *   still shown as grantable here.
 * - Granting a tool that carries a confirm note (chat_search) is routed
 *   through the confirm dialog before the checkbox can turn on.
 * - The provider picker hides the 'default' pseudo-provider and falls
 *   back to the first offered backend when the stored pick is gone.
 * - web_search takes a result count, web_search and http_fetch a
 *   concurrency cap; both clamp to 1–10, default 5, and coerce junk input
 *   to 5 instead of rejecting it.
 * - The cap is enforced per user on their own key but globally per
 *   provider when the shared environment key is in use.
 */
'use client';

import { useEffect } from 'react';
import { Tip } from '../lib/popover';
import { DEFAULT_CONCURRENCIES, DEFAULT_COUNTS, TOOLS } from '../lib/tools';
import {
  actions,
  modelDisabledTools,
  useDraftStore,
  useToolsStore,
} from '../stores';

export function ToolsClient() {
  const grants = useDraftStore((s) => s.toolGrants);
  const providers = useDraftStore((s) => s.toolProviders);
  const counts = useDraftStore((s) => s.defaultTools.counts);
  const concurrency = useDraftStore((s) => s.defaultTools.concurrency);
  const statuses = useToolsStore((s) => s.items);
  /* defaults aren't tied to a model, so only server readiness greys a tool out here */
  const disabled = modelDisabledTools(null, statuses);
  /* edits must land in the account defaults, never a chat the composer left open */
  useEffect(() => {
    actions.setContext('new');
  }, []);
  return (
    <>
      <div className="overflow-hidden rounded-[8px] border border-[var(--border)]">
        {TOOLS.map((t, i) => {
          const off = disabled.get(t.id);
          const provs = (statuses[t.id]?.providers ?? t.providers ?? []).filter(
            (p) => p !== 'default',
          );
          return (
            <div
              key={t.id}
              className={`flex h-10 items-center gap-3 bg-[var(--panel)] px-3 ${i > 0 ? 'border-t border-[var(--border)]' : ''}`}
            >
              <Tip label={t.description} side="top">
                <label
                  htmlFor={`tool-grant-${t.id}`}
                  className="w-[110px] cursor-pointer truncate text-[13px] font-medium"
                >
                  {t.label}
                </label>
              </Tip>
              <span className="min-w-0 flex-1 truncate text-[11px] muted">
                {off ?? t.description}
              </span>
              {provs.length > 0 && (
                <select
                  aria-label={`${t.label} provider`}
                  value={
                    provs.includes(providers[t.id] ?? '')
                      ? providers[t.id]
                      : provs[0]
                  }
                  onChange={(e) =>
                    actions.setToolProvider(t.id, e.target.value)
                  }
                  className="h-6 rounded-[4px] border border-[var(--border)] bg-[var(--raised)] px-1 text-[11px]"
                >
                  {provs.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              )}
              {t.id === 'web_search' && (
                <label className="flex shrink-0 items-center gap-1 text-[11px]">
                  results
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={counts[t.id] ?? DEFAULT_COUNTS[t.id] ?? 5}
                    onChange={(e) => {
                      const n = Math.min(
                        10,
                        Math.max(1, Math.trunc(Number(e.target.value) || 5)),
                      );
                      actions.setToolCount(t.id, n);
                    }}
                    className="h-6 w-12 rounded-[4px] border border-[var(--border)] bg-[var(--raised)] px-1 text-[11px]"
                  />
                </label>
              )}
              {(t.id === 'web_search' || t.id === 'http_fetch') && (
                <label className="flex shrink-0 items-center gap-1 text-[11px]">
                  concurrency
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={
                      concurrency[t.id] ?? DEFAULT_CONCURRENCIES[t.id] ?? 5
                    }
                    onChange={(e) => {
                      const n = Math.min(
                        10,
                        Math.max(1, Math.trunc(Number(e.target.value) || 5)),
                      );
                      actions.setToolConcurrency(t.id, n);
                    }}
                    className="h-6 w-12 rounded-[4px] border border-[var(--border)] bg-[var(--raised)] px-1 text-[11px]"
                  />
                </label>
              )}
              <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[11px]">
                <input
                  id={`tool-grant-${t.id}`}
                  type="checkbox"
                  checked={grants[t.id] === true && !off}
                  disabled={off !== undefined}
                  onChange={(e) => actions.setToolGrant(t.id, e.target.checked)}
                  className="size-3.5 accent-[var(--accent)]"
                />
                grant
              </label>
            </div>
          );
        })}
      </div>
      <p className="text-[12px] muted">
        These toggles edit the default grants applied to new chats (permission
        matrix scope “all chats”). Per-chat overrides live in the composer’s
        tool bar.
      </p>
    </>
  );
}

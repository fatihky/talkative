/*
 * ModelsSettings — the merged model list under providers on
 * /settings/providers, where each model's catalog row can be corrected
 * and models the provider never listed can be added.
 *
 * Business logic:
 * - Rows come from the model-overrides store: the server's catalog with
 *   the user's overrides applied, plus custom models. Editing one opens
 *   the form inline (model-override-form.tsx); each row owns its open
 *   state, so several rows can be edited at once.
 * - Reset drops the row (DELETE), returning the model to its catalog
 *   values; a custom model disappears with it. Hide saves the stored row
 *   back with `hidden` set and Unhide PUTs it back with `hidden` cleared,
 *   so its other overrides survive both ways; a row with nothing else set
 *   is dropped by the server as "empty".
 * - Hidden models aren't in the payload, so they are kept beside it with
 *   their provider name; the provider filter narrows them too. They list
 *   under a Hidden section, grouped by provider, each row showing its
 *   remote id (the `${connectionId}:` database prefix is dropped) with an
 *   "Unhide" button.
 * - Search ANDs every whitespace-separated term against name, id,
 *   provider and capability keywords; the counter turns into shown/total
 *   while filtering.
 * - The provider filter (its name in the connection list or a chip)
 *   narrows the already loaded list; it never refetches. The chips are
 *   the enabled connections, one per name, so a provider with every
 *   model hidden stays reachable; the counter is shown/total while
 *   filtering.
 * - Rows group by provider, one group each in first-seen order, keeping
 *   the numeric-aware alphabetical order the store applied within it.
 * - Add model needs at least one connection: its form picks which one
 *   carries the request.
 * - 'stale' marks models served from a cached catalog after the upstream
 *   fetch failed, so a dead provider still lists what it last reported.
 * - An overridden model is badged so an edited row is never mistaken for
 *   what the provider said. Its capabilities show as icon badges with
 *   tooltips, one per flag the model reports (the composer's glyphs), so
 *   absent means "no"; thinking keeps its level list as text beside them.
 * - The last 5 models used across chats lead the list as a "Recent"
 *   group of the same rows (narrowed by the provider filter, hidden while
 *   searching); each row names its provider, and opening one clears both
 *   filters so the form's row is on screen.
 */
'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'waku';
import { ctxFmt, humanBytes } from '../lib/format';
import { I } from '../lib/icons';
import { modelSearchText } from '../lib/models';
import type { ModelOverrideBody } from '../lib/api';
import type { Model, ModelOverrideDto } from '../types';
import { actions, useModelOverridesStore, useRecentModelIds } from '../stores';
import { errorText } from '../stores/models';
import {
  CAP_BADGES,
  ModelOverrideForm,
  orderLevels,
} from './model-override-form';

export function ModelsSettings({
  focusProvider,
  onFocusProvider,
}: {
  /* the provider connection name to filter by, set by the provider list */
  focusProvider?: string | undefined;
  /* null once the provider list drops the focus again */
  onFocusProvider?: (provider: string | null) => void;
} = {}) {
  const models = useModelOverridesStore((s) => s.items);
  const hidden = useModelOverridesStore((s) => s.hidden);
  const orphans = useModelOverridesStore((s) => s.orphans);
  const saving = useModelOverridesStore((s) => s.saving);
  const status = useModelOverridesStore((s) => s.status);
  const connections = useModelOverridesStore((s) => s.connections);
  const router = useRouter();
  /* a ?model=<id> deep link (from the composer's thinking note) prefills the search */
  const modelParam = useMemo(
    () => new URLSearchParams(router.query).get('model') ?? '',
    [router.query],
  );
  const [modelQuery, setModelQuery] = useState(modelParam);
  /* the row a ?model=<id> link points at: its form opens on mount */
  const focusId = modelParam || null;
  /* provider filter via the handoff's `.model-chip` pills; empty = all */
  const [providerFilter, setProviderFilter] = useState('');
  /* the chips and the provider list drive one filter: outside focus wins */
  const active = focusProvider || providerFilter;
  /* the chips are the enabled connections (one per name), so a provider whose
     every model is hidden or whose catalog failed is still reachable */
  const providers = [...new Set(connections.map((c) => c.name))];
  const setActive = (p: string) => {
    const next = active === p ? '' : p;
    setProviderFilter(next);
    onFocusProvider?.(next || null);
  };
  /* the add-model form is the only form owned by the list; rows own theirs */
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  /* every whitespace-separated term must hit the name, id or provider */
  const terms = modelQuery.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (m: Model) => {
    if (active && m.provider !== active) return false;
    if (!terms.length) return true;
    const hay = modelSearchText(m).toLowerCase();
    return terms.every((t) => hay.includes(t));
  };
  const shownModels = models.filter(matches);

  const hiddenShown = hidden.filter(
    (h) =>
      (!active || h.provider === active) &&
      terms.every((t) => h.id.toLowerCase().includes(t)),
  );

  /* hidden rows grouped by provider, first-seen order, like the visible groups */
  const hiddenByProvider = new Map<string, typeof hiddenShown>();
  for (const h of hiddenShown) {
    const key = h.provider ?? '';
    const items = hiddenByProvider.get(key);
    if (items) items.push(h);
    else hiddenByProvider.set(key, [h]);
  }

  const recentIds = useRecentModelIds(5);
  /* the models chats were last carried by, newest work first; ones the catalog
     no longer lists (or that the provider filter excludes) drop out */
  const recentModels = recentIds.flatMap((id) => {
    const m = models.find((x) => x.id === id);
    return m && (!active || m.provider === active) ? [m] : [];
  });

  /* one group per provider in first-seen order; rows keep the alphabetical
     order applied on load */
  const byProvider = new Map<string, Model[]>();
  for (const m of shownModels) {
    const items = byProvider.get(m.provider);
    if (items) items.push(m);
    else byProvider.set(m.provider, [m]);
  }
  const modelGroups = [...byProvider].map(([provider, items]) => ({
    provider,
    items,
  }));

  const setError = (e: unknown) => setActionError(errorText(e));

  /* a stored override is already a valid PUT body: sending it back keeps the
     row's other fields, since a PUT replaces the row instead of patching it */
  const withRow = (
    o: ModelOverrideDto | undefined,
    hidden: boolean,
  ): ModelOverrideBody => ({ ...(o ?? {}), hidden });

  const hide = (m: Model) => {
    setActionError(null);
    actions.save(m.id, withRow(m.overrides, true)).catch(setError);
  };

  const unhide = (id: string) => {
    setActionError(null);
    /* a row with no other overrides is dropped by the server as "empty" */
    actions
      .save(id, withRow(hidden.find((h) => h.id === id)?.override, false))
      .catch(setError);
  };

  const reset = (id: string) => {
    setActionError(null);
    actions.reset(id).catch(setError);
  };

  /* a recent row's form sits outside the filters: opening it clears both so
     the row is on screen */
  const openRecent = () => {
    setActionError(null);
    setModelQuery('');
    setProviderFilter('');
    onFocusProvider?.(null);
  };

  return (
    <section className="rounded-[8px] border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="sec-label">Models — capability overrides</div>
        <span className="num text-[11px] muted">
          {terms.length || active
            ? `${shownModels.length}/${models.length}`
            : models.length}
        </span>
        {active && (
          <button
            type="button"
            onClick={() => setActive(active)}
            className="ctl-ghost h-6 shrink-0 rounded-[6px] px-1.5 text-[11px] muted"
          >
            {active} ×
          </button>
        )}
        <button
          type="button"
          disabled={connections.length === 0}
          title={
            connections.length === 0
              ? 'Add a provider first'
              : 'Add a model the provider does not list'
          }
          onClick={() => {
            setActionError(null);
            setAdding(true);
          }}
          className="ctl ml-auto h-7 rounded-[6px] px-2 text-[12px] disabled:opacity-50"
        >
          Add model
        </button>
        <div className="flex h-7 w-[200px] min-w-0 items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] px-2">
          <I n="search" s={12} className="muted shrink-0" />
          <input
            value={modelQuery}
            onChange={(e) => setModelQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setModelQuery('');
            }}
            placeholder="Search models…"
            aria-label="Search models"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-[var(--text-3)]"
          />
        </div>
      </div>

      {actionError && (
        <div className="mb-2 text-[12px] text-[var(--danger)]">{actionError}</div>
      )}

      {orphans.length > 0 && (
        <div className="mb-2">
          <div className="sec-label mb-1 flex items-center gap-1.5 pt-1">
            <I n="grid" s={12} />
            <span>Unmatched overrides</span>
            <span className="num text-[11px] muted">{orphans.length}</span>
          </div>
          <div className="mb-1 text-[11px] muted">
            No enabled provider lists these models, so they don't appear
            anywhere else. Delete the ones you no longer need.
          </div>
          {orphans.map(({ id, override }) => (
            <div
              key={id}
              className="flex min-h-8 items-center gap-2 border-b border-[var(--border)] py-1 text-[12px] last:border-b-0"
            >
              <span className="flex-1 truncate font-medium">
                {override.shortName ?? override.remoteId}
              </span>
              <span className="num truncate muted" title={id}>
                {id}
              </span>
              <button
                type="button"
                onClick={() => reset(id)}
                disabled={saving}
                className="ctl-ghost h-6 shrink-0 rounded-[6px] px-1.5 text-[11px] text-[var(--danger)] disabled:opacity-50"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      {providers.length > 1 && (
        <div className="model-chip-row">
          {providers.map((p) => (
            <button
              key={p}
              type="button"
              className={`model-chip fltr ${active === p ? 'on' : ''}`}
              aria-pressed={active === p}
              onClick={() => setActive(p)}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {recentModels.length > 0 && !terms.length && (
        <div className="mb-2">
          <div className="sec-label mb-1 flex items-center gap-1.5 pt-1">
            <I n="clock" s={12} />
            <span>Recent</span>
            <span className="num text-[11px] muted">
              {recentModels.length}
            </span>
          </div>
          <div className="flex flex-col">
            {recentModels.map((m) => (
              <ModelRow
                key={m.id}
                m={m}
                showProvider
                onOpen={openRecent}
                onHide={() => hide(m)}
                onReset={() => reset(m.id)}
              />
            ))}
          </div>
        </div>
      )}

      {models.length === 0 && hidden.length === 0 && status !== 'loading' && (
        <div className="text-[12px] muted">
          {!active
            ? 'No models yet — add a provider above, then correct its catalog here.'
            : `No models from ${active} — it may be disabled or unreachable.`}
        </div>
      )}

      <div className="flex flex-col">
        {(terms.length > 0 || active) &&
          shownModels.length === 0 &&
          hiddenShown.length === 0 && (
            <div className="py-2 text-[12px] muted">
              No models match
              {modelQuery.trim() ? ` “${modelQuery.trim()}”` : ''}
              {active ? ` in ${active}` : ''}
            </div>
          )}

        {modelGroups.map((g, gi) => (
          <div key={g.provider} className={gi > 0 ? 'mt-2' : undefined}>
            <div className="sec-label mb-1 flex items-center gap-1.5 pt-1">
              <I n="grid" s={12} />
              <span className="break-words">{g.provider}</span>
              <span className="num text-[11px] muted">{g.items.length}</span>
            </div>
            <div className="flex flex-col">
              {g.items.map((m) => (
                <ModelRow
                  key={m.id}
                  m={m}
                  initiallyOpen={m.id === focusId}
                  onOpen={() => setActionError(null)}
                  onHide={() => hide(m)}
                  onReset={() => reset(m.id)}
                />
              ))}
            </div>
          </div>
        ))}

        {hiddenShown.length > 0 && (
          <div className="mt-2">
            <div className="sec-label mb-1 flex items-center gap-1.5 pt-1">
              <I n="grid" s={12} />
              <span>Hidden</span>
              <span className="num text-[11px] muted">
                {hiddenShown.length}
              </span>
            </div>
            {[...hiddenByProvider].map(([provider, rows], gi) => (
              <div key={provider} className={gi > 0 ? 'mt-2' : undefined}>
                <div className="mb-1 flex items-center gap-1.5 break-words text-[11px] muted">
                  <span>{provider || 'Unknown provider'}</span>
                  <span className="num">{rows.length}</span>
                </div>
                {rows.map(({ id }) => (
                  <div
                    key={id}
                    className="flex min-h-8 items-center gap-2 border-b border-[var(--border)] py-1 text-[12px] last:border-b-0"
                  >
                    <span className="num flex-1 truncate muted">
                      {remoteIdOf(id)}
                    </span>
                    <button
                      type="button"
                      onClick={() => unhide(id)}
                      className="ctl-ghost h-6 shrink-0 rounded-[6px] px-1.5 text-[11px]"
                    >
                      Unhide
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {adding && (
        <ModelOverrideForm
          initial={null}
          connections={connections}
          onDone={() => setAdding(false)}
        />
      )}
    </section>
  );
}

/* a model id is `${connectionId}:${remoteId}`; the remote id may hold colons
   of its own, so only the leading connection id is dropped */
const remoteIdOf = (id: string) => id.replace(/^\d+:/, '');

function CapBadges({ caps }: { caps: Model['capabilities'] }) {
  const on = CAP_BADGES.filter((b) => caps[b.key]);
  return (
    <span className="flex shrink-0 items-center gap-1">
      {on.map((b) => (
        <span
          key={b.key}
          title={`${b.label} — ${b.hint}`}
          aria-label={b.label}
          className="grid size-[18px] place-items-center rounded-[4px] border border-[var(--border)] bg-[var(--bg)] text-[var(--text-2)]"
        >
          <I n={b.icon} s={11} />
        </span>
      ))}
    </span>
  );
}

function ModelRow({
  m,
  initiallyOpen = false,
  showProvider = false,
  onOpen,
  onHide,
  onReset,
}: {
  m: Model;
  /* a deep link opens its row once, on mount; after that the row owns its state */
  initiallyOpen?: boolean;
  /* the row sits outside its provider group (the recent list), so it names it */
  showProvider?: boolean;
  /* fired when the form opens, so the list can clear what hides the row */
  onOpen?: () => void;
  onHide: () => void;
  onReset: () => void;
}) {
  const o = m.overrides;
  const connections = useModelOverridesStore((s) => s.connections);
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <div className="border-b border-[var(--border)] py-1 last:border-b-0">
      <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
        <span className="w-[160px] shrink-0 break-words font-medium">
          {m.shortName}
        </span>
        <span className="num w-[50px] shrink-0 muted">{m.params ?? '—'}</span>
        <span className="num w-[70px] shrink-0">{ctxFmt(m.context.window)}</span>
        <CapBadges caps={m.capabilities} />
        <span
          className="flex-1 truncate text-[11px] muted"
          title={
            m.thinkingLevels === undefined
              ? 'thinking levels not reported by this provider'
              : m.thinkingLevels.length === 0
                ? 'thinking not available'
                : `thinking levels: ${orderLevels(m.thinkingLevels).join(' / ')}`
          }
        >
          {m.thinkingLevels?.length
            ? `thinking: ${orderLevels(m.thinkingLevels).join('/')}${
                m.defaultThinkingLevel
                  ? ` · default:${m.defaultThinkingLevel}`
                  : ''
              }`
            : m.thinkingLevels === undefined
              ? 'thinking: unknown'
              : 'thinking: no'}
        </span>
        {m.kind && m.kind !== 'llm' && (
          <span className="shrink-0 rounded-[4px] bg-[var(--sunken)] px-1 text-[10px] muted">
            {m.kind}
          </span>
        )}
        {o && (
          <span
            className="shrink-0 rounded-[4px] bg-[var(--accent-soft)] px-1 text-[10px]"
            title="edited — these are your values, not the provider's"
          >
            {o.custom ? 'custom' : 'overridden'}
          </span>
        )}
        {m.status === 'error' && (
          <span className="shrink-0 text-[var(--danger)]">no key</span>
        )}
        {m.status === 'stale' && (
          <span className="shrink-0 text-[var(--warn)]">stale</span>
        )}
        <span className="flex-1" />
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => {
              if (!open) onOpen?.();
              setOpen(!open);
            }}
            aria-expanded={open}
            className="ctl-ghost h-6 rounded-[6px] px-1.5 text-[11px]"
          >
            {open ? 'Close' : 'Edit'}
          </button>
          <button
            type="button"
            onClick={onHide}
            className="ctl-ghost h-6 rounded-[6px] px-1.5 text-[11px]"
          >
            Hide
          </button>
          {o && (
            <button
              type="button"
              onClick={onReset}
              className="ctl-ghost h-6 rounded-[6px] px-1.5 text-[11px] muted"
              title="Back to what the provider reports"
            >
              Reset
            </button>
          )}
        </div>
        {(m.meta?.architecture ||
          m.meta?.quantization ||
          m.meta?.format ||
          m.meta?.sizeBytes !== undefined) && (
          <span className="num w-full truncate text-[11px] muted">
            {[
              m.meta?.architecture,
              m.meta?.quantization,
              m.meta?.format?.toUpperCase(),
              m.meta?.sizeBytes !== undefined
                ? humanBytes(m.meta.sizeBytes)
                : undefined,
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        )}
        {o?.custom && (
          <span className="num w-full truncate text-[11px] muted">
            sends “{o.remoteId}” to{' '}
            {connections.find((c) => c.id === o.connectionId)?.name ??
              `connection ${o.connectionId}`}
            {o.baseUrl ? ` · ${o.baseUrl}` : ''}
          </span>
        )}
        {showProvider && (
          <span className="num w-full truncate text-[11px] muted">
            {m.provider}
          </span>
        )}
      </div>
      {open && (
        <ModelOverrideForm
          initial={m}
          connections={connections}
          onDone={() => setOpen(false)}
        />
      )}
    </div>
  );
}

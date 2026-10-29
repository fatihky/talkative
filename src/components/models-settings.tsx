/*
 * ModelsSettings — the merged model list under providers on
 * /settings/providers, where each model's catalog row can be corrected
 * and models the provider never listed can be added.
 *
 * Business logic:
 * - Rows come from the model-overrides store: the server's catalog with
 *   the user's overrides applied, plus custom models. Editing one opens
 *   the form inline; saving PUTs only what differs from the catalog row,
 *   so a clear field never overwrites a value the provider reports.
 * - The form pins a few rules the server enforces too: thinking is on
 *   exactly when a level above "off" is selected (a reasoner with no
 *   level to offer would leave the composer nothing to ask), the
 *   default level must be one of the selected levels, and a custom
 *   model needs a connection and the upstream model name.
 * - Reset drops the row (DELETE), returning the model to its catalog
 *   values; a custom model disappears with it. Hide is the same row with
 *   `hidden` set, so its other overrides survive until it is unhidden.
 * - Hidden models aren't in the payload, so they are kept beside it with
 *   their provider name; the provider filter narrows them too and the
 *   list shows an "Unhide" row.
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
 *   An overridden model is badged so an edited row is never mistaken for
 *   what the provider said.
 */
'use client';

import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'waku';
import { ctxFmt, humanBytes } from '../lib/format';
import { I } from '../lib/icons';
import { modelSearchText } from '../lib/models';
import type { ModelOverrideBody } from '../lib/api';
import type { Model, ModelKind, ThinkingLevel } from '../types';
import { actions, useModelOverridesStore } from '../stores';
import { errorText } from '../stores/models';

const LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high'];
const CAPS = ['vision', 'tools', 'audio', 'json', 'fast', 'decisions'] as const;
const KINDS: ModelKind[] = ['llm', 'decision', 'systemone'];
const inputCls =
  'h-7 w-full rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] px-2 text-[12px] outline-none focus:border-[var(--accent)]';

/* a level list sorted least → most thinking, for display */
const orderLevels = (l: ThinkingLevel[]) =>
  LEVELS.filter((x) => l.includes(x));

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
  const status = useModelOverridesStore((s) => s.status);
  const connections = useModelOverridesStore((s) => s.connections);
  const router = useRouter();
  /* a ?model=<id> deep link (from the composer's thinking note) prefills the search */
  const modelParam = useMemo(
    () => new URLSearchParams(router.query).get('model') ?? '',
    [router.query],
  );
  const [modelQuery, setModelQuery] = useState(modelParam);
  /* the row a ?model=<id> link points at, to open its form once the list lands */
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
  /* null = no form, 'new' = add a custom model, otherwise the id being edited */
  const [editing, setEditing] = useState<'new' | string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const focused = useRef<string | null>(null);
  useEffect(() => {
    if (!focusId || focused.current === focusId) return;
    if (!models.some((m) => m.id === focusId)) return;
    focused.current = focusId;
    setEditing(focusId);
  }, [focusId, models]);

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

  const hide = (m: Model) => {
    setActionError(null);
    actions
      .save(m.id, { connectionId: m.connectionId, hidden: true })
      .catch(setError);
  };

  const unhide = (id: string) => {
    setActionError(null);
    /* a row with no other overrides is dropped by the server as "empty" */
    actions.save(id, { hidden: false }).catch(setError);
  };

  const reset = (id: string) => {
    setActionError(null);
    actions.reset(id).catch(setError);
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
          disabled={connections.length === 0 || editing === 'new'}
          title={
            connections.length === 0
              ? 'Add a provider first'
              : 'Add a model the provider does not list'
          }
          onClick={() => {
            setActionError(null);
            setEditing('new');
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
                  editing={editing === m.id}
                  onEdit={() => {
                    setActionError(null);
                    setEditing(editing === m.id ? null : m.id);
                  }}
                  onHide={() => hide(m)}
                  onReset={() => reset(m.id)}
                  onDone={() => setEditing(null)}
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
            {hiddenShown.map(({ id }) => (
              <div
                key={id}
                className="flex min-h-8 items-center gap-2 border-b border-[var(--border)] py-1 text-[12px] last:border-b-0"
              >
                <span className="num flex-1 truncate muted">{id}</span>
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
        )}
      </div>

      {editing === 'new' && (
        <OverrideForm
          key="new"
          initial={null}
          connections={connections}
          onDone={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function ModelRow({
  m,
  editing,
  onEdit,
  onHide,
  onReset,
  onDone,
}: {
  m: Model;
  editing: boolean;
  onEdit: () => void;
  onHide: () => void;
  onReset: () => void;
  onDone: () => void;
}) {
  const o = m.overrides;
  const connections = useModelOverridesStore((s) => s.connections);
  return (
    <div className="border-b border-[var(--border)] py-1 last:border-b-0">
      <div className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px]">
        <span className="w-[160px] shrink-0 break-words font-medium">
          {m.shortName}
        </span>
        <span className="num w-[50px] shrink-0 muted">{m.params ?? '—'}</span>
        <span className="num w-[70px] shrink-0">{ctxFmt(m.context.window)}</span>
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
        <span className="flex-1 truncate muted">
          thinking:
          {m.thinkingLevels === undefined
            ? 'unknown'
            : m.thinkingLevels.length === 0
              ? 'no'
              : 'yes'}
          {m.defaultThinkingLevel
            ? ` · default:${m.defaultThinkingLevel}`
            : ''}
          {m.thinkingLevels?.length
            ? ` · levels:${orderLevels(m.thinkingLevels).join('/')}`
            : ''}{' '}
          · vision:{m.capabilities.vision ? 'yes' : 'no'} · tools:
          {m.capabilities.tools ? 'yes' : 'no'} · decisions:
          {m.capabilities.decisions ? 'yes' : 'no'}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={onEdit}
            aria-expanded={editing}
            className="ctl-ghost h-6 rounded-[6px] px-1.5 text-[11px]"
          >
            {editing ? 'Close' : 'Edit'}
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
      </div>
      {editing && (
        <OverrideForm
          initial={m}
          connections={connections}
          onDone={onDone}
        />
      )}
    </div>
  );
}

/* what the form starts from: the catalog row, so a clear field is a no-op */
type FormState = {
  custom: boolean;
  connectionId: number;
  remoteId: string;
  baseUrl: string;
  shortName: string;
  kind: ModelKind;
  contextWindow: string;
  maxOutput: string;
  levels: ThinkingLevel[];
  dflt: ThinkingLevel | '';
  params: string;
  caps: Record<(typeof CAPS)[number], boolean>;
  pricing: { input: string; cachedInput: string; output: string };
};

const toForm = (m: Model | null, connections: { id: number }[]): FormState => {
  const o = m?.overrides;
  return {
    custom: o?.custom === true,
    connectionId: o?.connectionId ?? connections[0]?.id ?? 0,
    remoteId: o?.remoteId ?? m?.remoteId ?? '',
    baseUrl: o?.baseUrl ?? '',
    shortName: o?.shortName ?? '',
    kind: o?.kind ?? m?.kind ?? 'llm',
    contextWindow: String(o?.contextWindow ?? m?.context.window ?? ''),
    maxOutput: String(o?.maxOutput ?? m?.context.maxOutput ?? ''),
    levels: orderLevels(o?.thinkingLevels ?? m?.thinkingLevels ?? []),
    dflt: o?.defaultThinkingLevel ?? m?.defaultThinkingLevel ?? '',
    params: o?.params ?? m?.params ?? '',
    caps: Object.fromEntries(
      CAPS.map((k) => [k, o?.capabilities?.[k] ?? m?.capabilities[k] ?? false]),
    ) as FormState['caps'],
    pricing: {
      input: String(o?.pricing?.input ?? m?.pricing.input ?? ''),
      cachedInput: String(o?.pricing?.cachedInput ?? m?.pricing.cachedInput ?? ''),
      output: String(o?.pricing?.output ?? m?.pricing.output ?? ''),
    },
  };
};

const num = (v: string): number | undefined => {
  const n = Number(v.trim());
  return v.trim() === '' || !Number.isFinite(n) || n < 0 ? undefined : n;
};

function OverrideForm({
  initial,
  connections,
  onDone,
}: {
  /* the catalog row being edited, or null when adding a custom model */
  initial: Model | null;
  connections: { id: number; name: string }[];
  onDone: () => void;
}) {
  const saving = useModelOverridesStore((s) => s.saving);
  const [f, setF] = useState<FormState>(() => toForm(initial, connections));
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Partial<FormState>) => setF((cur) => ({ ...cur, ...p }));

  /* the id the row is stored under: an edited row keeps its id, a new custom
     model gets one derived from the connection and upstream name */
  const modelId =
    initial?.id ??
    (f.connectionId && f.remoteId.trim()
      ? `custom:${f.connectionId}:${f.remoteId.trim()}`
      : '');

  const toggleLevel = (l: ThinkingLevel) => {
    const has = f.levels.includes(l);
    const levels = orderLevels(
      has ? f.levels.filter((x) => x !== l) : [...f.levels, l],
    );
    patch({
      levels,
      ...(f.dflt && !levels.includes(f.dflt) ? { dflt: '' as const } : {}),
    });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!modelId) {
      setError('name the upstream model first');
      return;
    }
    const thinking = f.levels.some((l) => l !== 'off');
    const body: ModelOverrideBody = {
      hidden: false,
      ...(f.custom
        ? {
            custom: true,
            connectionId: f.connectionId,
            remoteId: f.remoteId.trim(),
            ...(f.baseUrl.trim() ? { baseUrl: f.baseUrl.trim() } : {}),
            kind: f.kind,
          }
        : {}),
      thinkingLevels: f.levels,
      ...(thinking ? { capabilities: { ...f.caps, thinking: true } } : {}),
      ...(f.shortName.trim() ? { shortName: f.shortName.trim() } : {}),
      ...(num(f.contextWindow) !== undefined
        ? { contextWindow: num(f.contextWindow) }
        : {}),
      ...(num(f.maxOutput) !== undefined
        ? { maxOutput: num(f.maxOutput) }
        : {}),
      ...(f.dflt ? { defaultThinkingLevel: f.dflt } : {}),
      ...(f.params.trim() ? { params: f.params.trim() } : {}),
      pricing: {
        ...(num(f.pricing.input) !== undefined
          ? { input: num(f.pricing.input) ?? 0 }
          : {}),
        ...(num(f.pricing.cachedInput) !== undefined
          ? { cachedInput: num(f.pricing.cachedInput) ?? 0 }
          : {}),
        ...(num(f.pricing.output) !== undefined
          ? { output: num(f.pricing.output) ?? 0 }
          : {}),
      },
    };
    try {
      await actions.save(modelId, body);
      onDone();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const label = (t: string) => (
    <span className="w-[64px] shrink-0 text-[11px] muted">{t}</span>
  );

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="my-1 flex flex-col gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--bg)] p-2"
    >
      {f.custom && (
        <>
          <label className="flex items-center gap-1.5 text-[12px]">
            {label('Provider')}
            <select
              value={f.connectionId}
              onChange={(e) => patch({ connectionId: Number(e.target.value) })}
              className={inputCls}
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[12px]">
            {label('Model id')}
            <input
              required
              value={f.remoteId}
              onChange={(e) => patch({ remoteId: e.target.value })}
              placeholder="upstream model name, e.g. gpt-5.2"
              className={`num ${inputCls}`}
            />
          </label>
          <label className="flex items-center gap-1.5 text-[12px]">
            {label('Base URL')}
            <input
              type="url"
              value={f.baseUrl}
              onChange={(e) => patch({ baseUrl: e.target.value })}
              placeholder="optional — defaults to the provider's"
              className={`num ${inputCls}`}
            />
          </label>
          <label className="flex items-center gap-1.5 text-[12px]">
            {label('Kind')}
            <select
              value={f.kind}
              onChange={(e) => patch({ kind: e.target.value as ModelKind })}
              className={inputCls}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <label className="flex items-center gap-1.5 text-[12px]">
        {label('Name')}
        <input
          value={f.shortName}
          onChange={(e) => patch({ shortName: e.target.value })}
          placeholder={initial?.shortName ?? 'display name'}
          className={inputCls}
        />
      </label>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        {label('Context')}
        <input
          type="number"
          min={0}
          value={f.contextWindow}
          onChange={(e) => patch({ contextWindow: e.target.value })}
          placeholder="window"
          aria-label="Context window"
          className={`num ${inputCls} !w-[110px]`}
        />
        <input
          type="number"
          min={0}
          value={f.maxOutput}
          onChange={(e) => patch({ maxOutput: e.target.value })}
          placeholder="max output"
          aria-label="Max output tokens"
          className={`num ${inputCls} !w-[110px]`}
        />
        <input
          value={f.params}
          onChange={(e) => patch({ params: e.target.value })}
          placeholder="params"
          aria-label="Parameter count (e.g. 8B)"
          className={`num ${inputCls} !w-[70px]`}
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        {label('Thinking')}
        {LEVELS.map((l) => (
          <label key={l} className="flex cursor-pointer items-center gap-1">
            <input
              type="checkbox"
              checked={f.levels.includes(l)}
              onChange={() => toggleLevel(l)}
              className="size-3.5 accent-[var(--accent)]"
            />
            {l}
          </label>
        ))}
        <span className="text-[11px] muted">default</span>
        <select
          value={f.dflt}
          onChange={(e) =>
            patch({ dflt: e.target.value as ThinkingLevel | '' })
          }
          aria-label="Default thinking level"
          className={`${inputCls} !w-[90px]`}
        >
          <option value="">—</option>
          {f.levels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        {label('Supports')}
        {CAPS.map((k) => (
          <label key={k} className="flex cursor-pointer items-center gap-1">
            <input
              type="checkbox"
              checked={f.caps[k]}
              onChange={(e) =>
                patch({ caps: { ...f.caps, [k]: e.target.checked } })
              }
              className="size-3.5 accent-[var(--accent)]"
            />
            {k}
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        {label('$/M tok')}
        {(['input', 'cachedInput', 'output'] as const).map((k) => (
          <input
            key={k}
            type="number"
            min={0}
            step="any"
            value={f.pricing[k]}
            onChange={(e) =>
              patch({ pricing: { ...f.pricing, [k]: e.target.value } })
            }
            placeholder={k}
            aria-label={`Price per million ${k} tokens`}
            className={`num ${inputCls} !w-[100px]`}
          />
        ))}
      </div>
      {error && <div className="text-[12px] text-[var(--danger)]">{error}</div>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="ctl-ghost h-7 rounded-[6px] px-2 text-[12px]"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="ctl-primary h-7 rounded-[6px] px-3 text-[12px]"
        >
          {saving ? 'Saving…' : f.custom ? 'Add model' : 'Save'}
        </button>
      </div>
    </form>
  );
}

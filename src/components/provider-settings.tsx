/*
 * ProviderSettings — CRUD for the user's LLM provider connections and
 * their model catalogs, on /settings/providers.
 *
 * Business logic:
 * - Connections are per user and loaded on mount; a row shows name,
 *   compatibility and base URL but never the key — the API only reports
 *   hasApiKey, and stored keys are sealed at rest server-side.
 * - The switch toggles `enabled`: a disabled provider keeps its config
 *   but drops out of the merged catalog the composer picks from.
 * - Catalog state per connection reads loading… / "N models · synced ago"
 *   / "N models (stale)" / unreachable, with the upstream error kept as
 *   the tooltip — a failing provider is surfaced, not swallowed.
 * - Refresh is off unless the provider is enabled and isn't already
 *   syncing; any save, toggle or refresh re-merges the shared model list.
 * - Five compatibilities are offered (openai, openrouter, lmstudio,
 *   ollama, bifrost), each suggesting its own base URL.
 * - The key field is write-only: blank keeps the stored key when editing,
 *   the "Remove stored API key" box sends an explicit null, and a new
 *   provider may be saved without one (local runtimes need none).
 * - Removing asks for confirmation first; with no providers at all the
 *   model picker falls back to the demo catalog.
 * - The provider name is a button: clicking it (on the hooks given by the
 *   page) filters the model catalog below to that provider's connection,
 *   clicking it again clears the filter. Pressing it on a provider that
 *   serves no models just states that the catalog is empty.
 */
'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { timeAgo } from '../lib/format';
import { actions, useProvidersStore } from '../stores';
import { errorText } from '../stores/models';
import type {
  Compatibility,
  ProviderConnection,
  ProviderConnectionInput,
} from '../types';
import { IconButton, Switch } from '../ui/primitives';

const COMPAT: { id: Compatibility; label: string; placeholder: string }[] = [
  { id: 'openai', label: 'OpenAI', placeholder: 'https://api.openai.com' },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    placeholder: 'https://openrouter.ai',
  },
  { id: 'lmstudio', label: 'LM Studio', placeholder: 'http://localhost:1234' },
  { id: 'ollama', label: 'Ollama', placeholder: 'http://localhost:11434' },
  { id: 'bifrost', label: 'Bifrost', placeholder: 'http://localhost:8080' },
];

const compatLabel = (c: Compatibility) =>
  COMPAT.find((x) => x.id === c)?.label ?? c;

const inputCls =
  'h-8 w-full rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] px-2 text-[13px] outline-none focus:border-[var(--accent)]';

export function ProviderSettings({
  focusedProvider,
  onFocusProvider,
}: {
  /* the connection name the model catalog is filtered by */
  focusedProvider?: string | undefined;
  /* null clears the model catalog's provider filter */
  onFocusProvider?: (provider: string | null) => void;
} = {}) {
  const { items, status, error, catalogs } = useProvidersStore();
  /* null = closed, 'new' = add form, otherwise the connection being edited */
  const [editing, setEditing] = useState<'new' | ProviderConnection | null>(
    null,
  );

  useEffect(() => {
    void actions.loadProviders();
  }, []);

  const remove = async (p: ProviderConnection) => {
    if (!window.confirm(`Remove provider "${p.name}"?`)) return;
    try {
      await actions.deleteProvider(p.id);
    } catch (e) {
      window.alert(errorText(e));
    }
  };

  const toggle = async (p: ProviderConnection, enabled: boolean) => {
    try {
      await actions.setProviderEnabled(p.id, enabled);
    } catch (e) {
      window.alert(errorText(e));
    }
  };

  return (
    <section className="rounded-[8px] border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="mb-2 flex items-center">
        <div className="sec-label">API providers</div>
        {editing === null && (
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="ctl ml-auto h-7 rounded-[6px] px-2 text-[12px]"
          >
            Add provider
          </button>
        )}
      </div>

      {status === 'error' && (
        <div className="mb-2 text-[12px] text-[var(--danger)]">{error}</div>
      )}
      {status === 'ready' && items.length === 0 && editing === null && (
        <div className="text-[12px] muted">
          No providers yet — the model picker shows the demo catalog until you
          add one.
        </div>
      )}

      <div className="flex flex-col">
        {items.map((p) => {
          const cat = catalogs[p.id];
          return (
            <div
              key={p.id}
              className="flex min-h-9 items-center gap-2 border-b border-[var(--border)] text-[12px] last:border-b-0"
            >
              <Switch
                checked={p.enabled}
                onChange={(v) => void toggle(p, v)}
                label={`${p.enabled ? 'Disable' : 'Enable'} ${p.name}`}
              />
              <div
                className={`min-w-0 flex-1 ${p.enabled ? '' : 'opacity-50'}`}
              >
                <div className="flex flex-wrap items-center gap-x-2">
                  <button
                    type="button"
                    aria-pressed={
                      !!focusedProvider && focusedProvider === p.name
                    }
                    title={`Show ${p.name} models`}
                    onClick={() =>
                      onFocusProvider?.(
                        focusedProvider === p.name ? null : p.name,
                      )
                    }
                    className={`cursor-pointer break-words text-left font-medium hover:text-[var(--accent)] ${
                      focusedProvider === p.name ? 'text-[var(--accent)]' : ''
                    }`}
                  >
                    {p.name}
                  </button>
                  <span className="shrink-0 whitespace-nowrap muted">
                    {compatLabel(p.compatibility)}
                  </span>
                </div>
                <div className="flex min-w-0 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-2">
                  <span className="num min-w-0 break-words muted sm:flex-1">
                    {p.baseUrl}
                  </span>
                  <span
                    className={`shrink-0 whitespace-nowrap ${p.enabled && cat?.status === 'error' ? 'text-[var(--danger)]' : 'muted'}`}
                    title={cat?.error}
                  >
                    {!p.enabled
                      ? 'disabled'
                      : !cat || cat.status === 'loading'
                        ? 'loading…'
                        : cat.status === 'error'
                          ? cat.count > 0
                            ? `${cat.count} models (stale)`
                            : 'unreachable'
                          : `${cat.count} models${cat.syncedAt ? ` · ${timeAgo(cat.syncedAt)}` : ''}`}
                  </span>
                </div>
              </div>
              <IconButton
                icon="retry"
                tip="Refresh models"
                ghost
                size={24}
                disabled={!p.enabled || cat?.status === 'loading'}
                onClick={() => void actions.refreshProviderModels(p.id)}
              />
              <IconButton
                icon="settings"
                tip="Edit"
                ghost
                size={24}
                onClick={() => setEditing(p)}
              />
              <IconButton
                icon="trash"
                tip="Remove"
                ghost
                size={24}
                onClick={() => void remove(p)}
              />
            </div>
          );
        })}
      </div>

      {editing !== null && (
        <ProviderForm
          key={editing === 'new' ? 'new' : editing.id}
          initial={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function ProviderForm({
  initial,
  onDone,
}: {
  initial: ProviderConnection | null;
  onDone: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [compatibility, setCompatibility] = useState<Compatibility>(
    initial?.compatibility ?? 'openai',
  );
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const input: ProviderConnectionInput = {
      name,
      baseUrl,
      compatibility,
      /* editing: blank keeps the stored key unless explicitly cleared */
      ...(apiKey
        ? { apiKey }
        : clearKey
          ? { apiKey: null }
          : initial
            ? {}
            : { apiKey: null }),
    };
    try {
      if (initial) await actions.updateProvider(initial.id, input);
      else await actions.createProvider(input);
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const placeholder =
    COMPAT.find((c) => c.id === compatibility)?.placeholder ?? '';

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="mt-3 flex flex-col gap-2 rounded-[6px] border border-[var(--border)] p-3"
    >
      <label className="flex flex-col gap-1 text-[12px]">
        <span className="muted">Name</span>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My OpenRouter"
          className={inputCls}
        />
      </label>
      <label className="flex flex-col gap-1 text-[12px]">
        <span className="muted">Compatibility</span>
        <select
          required
          value={compatibility}
          onChange={(e) => setCompatibility(e.target.value as Compatibility)}
          className={inputCls}
        >
          {COMPAT.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[12px]">
        <span className="muted">Base URL</span>
        <input
          required
          type="url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={placeholder}
          className={`num ${inputCls}`}
        />
      </label>
      <label className="flex flex-col gap-1 text-[12px]">
        <span className="muted">
          API key{' '}
          {initial?.hasApiKey ? '(stored — leave blank to keep)' : '(optional)'}
        </span>
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          disabled={clearKey}
          className={inputCls}
        />
      </label>
      {initial?.hasApiKey && (
        <label className="flex cursor-pointer items-center gap-1.5 text-[12px]">
          <input
            type="checkbox"
            checked={clearKey}
            onChange={(e) => setClearKey(e.target.checked)}
            className="size-3.5 accent-[var(--accent)]"
          />
          Remove stored API key
        </label>
      )}
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
          disabled={busy}
          className="ctl-primary h-7 rounded-[6px] px-3 text-[12px]"
        >
          {busy ? 'Saving…' : initial ? 'Save' : 'Add provider'}
        </button>
      </div>
    </form>
  );
}

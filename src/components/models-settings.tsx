/*
 * ModelsSettings — read-only catalog of every model the user's enabled
 * providers serve, shown under providers on /settings/providers.
 *
 * Business logic:
 * - Search ANDs every whitespace-separated term against name, id,
 *   provider and capability keywords; the counter turns into shown/total
 *   while filtering.
 * - Rows group by provider, keeping the numeric-aware alphabetical order
 *   the catalog sync applied.
 * - The filter chips are the providers (connection names) that have at
 *   least one model, plus any connection the list asked to focus (a
 *   provider name click). A focused provider stays listed — and selected
 *   — even when the current search leaves it with nothing, so the chip
 *   that filters can always be unset.
 * - With no provider configured the client falls back to the demo
 *   catalog, whose unkeyed entries carry status 'error' → "no key".
 * - 'stale' marks models served from a cached catalog after the upstream
 *   fetch failed, so a dead provider still lists what it last reported.
 * - Non-llm kinds (decision/embedding) are badged here but stay out of
 *   the composer picker, which only sends to llm models.
 * - Thinking support reads unknown/no/yes plus the model's default level
 *   and available levels; vision, tools and decisions capabilities
 *   follow.
 * - Local-runtime metadata (architecture, quantization, format, size,
 *   variants) renders only when the provider reports it. Nothing on this
 *   page is editable — capabilities come from the catalog sync.
 */
'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'waku';
import { ctxFmt, humanBytes } from '../lib/format';
import { I } from '../lib/icons';
import { modelSearchText } from '../lib/models';
import { useModelsStore } from '../stores';

export function ModelsSettings({
  focusProvider,
  onFocusProvider,
}: {
  /* the provider connection name to filter by, set by the provider list */
  focusProvider?: string | undefined;
  /* null once the provider list drops the focus again */
  onFocusProvider?: (provider: string | null) => void;
} = {}) {
  const models = useModelsStore((s) => s.items);
  const router = useRouter();
  /* a ?model=<id> deep link (from the composer's thinking note) prefills the search */
  const modelParam = useMemo(
    () => new URLSearchParams(router.query).get('model') ?? '',
    [router.query],
  );
  const [modelQuery, setModelQuery] = useState(modelParam);
  /* provider filter via the handoff's `.model-chip` pills; empty = all */
  const [providerFilter, setProviderFilter] = useState('');
  /* the chips and the provider list drive one filter: outside focus wins */
  const active = focusProvider || providerFilter;
  const setActive = (p: string) => {
    const next = active === p ? '' : p;
    setProviderFilter(next);
    onFocusProvider?.(next || null);
  };
  /* every whitespace-separated term must hit the name, id or provider */
  const terms = modelQuery.toLowerCase().split(/\s+/).filter(Boolean);
  const shownModels = models.filter((m) => {
    if (terms.length) {
      const hay = modelSearchText(m).toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    if (active && m.provider !== active) return false;
    return true;
  });
  /* distinct providers in catalog order, for the filter chips; the focused
     one stays listed even with no models left so it can be switched off */
  const providers: string[] = [];
  for (const m of models)
    if (!providers.includes(m.provider)) providers.push(m.provider);
  if (active && !providers.includes(active)) providers.push(active);
  /* models group by provider, keeping the alphabetical order applied on sync */
  const modelGroups: { provider: string; items: typeof shownModels }[] = [];
  for (const m of shownModels) {
    const last = modelGroups[modelGroups.length - 1];
    if (last?.provider === m.provider) last.items.push(m);
    else modelGroups.push({ provider: m.provider, items: [m] });
  }
  return (
    <section className="rounded-[8px] border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="mb-2 flex items-center gap-2">
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
        <div className="ml-auto flex h-7 w-[200px] min-w-0 items-center gap-1.5 rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] px-2">
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
      <div className="flex flex-col">
        {(terms.length > 0 || active) && shownModels.length === 0 && (
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
                <div
                  key={m.id}
                  className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-[var(--border)] py-1 text-[12px] last:border-b-0"
                >
                  <span className="w-[160px] shrink-0 break-words font-medium">
                    {m.shortName}
                  </span>
                  <span className="num w-[50px] shrink-0 muted">
                    {m.params ?? '—'}
                  </span>
                  <span className="num w-[70px] shrink-0">
                    {ctxFmt(m.context.window)}
                  </span>
                  {m.kind && m.kind !== 'llm' && (
                    <span className="shrink-0 rounded-[4px] bg-[var(--sunken)] px-1 text-[10px] muted">
                      {m.kind}
                    </span>
                  )}
                  {m.status === 'error' && (
                    <span className="shrink-0 text-[var(--danger)]">
                      no key
                    </span>
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
                      ? ` · levels:${m.thinkingLevels.join('/')}`
                      : ''}{' '}
                    · vision:{m.capabilities.vision ? 'yes' : 'no'} · tools:
                    {m.capabilities.tools ? 'yes' : 'no'} · decisions:
                    {m.capabilities.decisions ? 'yes' : 'no'}
                  </span>
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
                  {m.meta?.variants && (
                    <span className="num w-full truncate text-[11px] muted">
                      variants:{m.meta.variants.join(', ')}
                      {m.meta.selectedVariant
                        ? ` · selected:${m.meta.selectedVariant}`
                        : ''}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

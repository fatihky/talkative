/*
 * DecisionModelPicker — the /decisions editor's model choice, styled after
 * the composer's ModelPicker.
 *
 * Business logic:
 * - models are grouped in run order: System One (kind 'systemone'), decision
 *   (kind 'decision'), then chat (llm) models — embedding models answer
 *   neither endpoint and never appear.
 * - search matches short name, id, provider and capability keywords
 *   (vision, decision, systemone, …); opening resets the query,
 *   focuses search, and highlights the current pick; arrows move and Enter
 *   selects.
 * - options carry provider, size, context window, per-M pricing and status
 *   badges ("no key"/"stale"), plus a kind tag so a search result is
 *   distinguishable; selecting writes the draft's modelId.
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ctxFmt } from '../lib/format';
import { I } from '../lib/icons';
import {
  isChattable,
  isDecisionModel,
  isSystemOneModel,
  modelSearchText,
} from '../lib/models';
import { Popover, Tip } from '../lib/popover';
import { actions, useDecisionsStore, useModelsStore } from '../stores';
import type { Model } from '../types';

const GROUP_ORDER = ['systemone', 'decision', 'llm'] as const;

export function DecisionModelPicker({
  invalid = false,
  shakeKey = 0,
}: {
  invalid?: boolean;
  shakeKey?: number;
} = {}) {
  const items = useModelsStore((s) => s.items);
  const status = useModelsStore((s) => s.status);
  const isSyncing = useModelsStore((s) => s.isSyncing);
  const selectedId = useDecisionsStore((s) => s.draft?.modelId ?? '');
  const [open, setOpen] = useState(false);
  const [shaking, setShaking] = useState(false);
  const [query, setQuery] = useState('');
  const [idx, setIdx] = useState(0);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listId = 'dmp-model-list';

  useEffect(() => {
    if (shakeKey > 0 && invalid) setShaking(true);
  }, [shakeKey, invalid]);

  const groups = useMemo(
    () =>
      GROUP_ORDER.map((kind) => ({
        kind,
        label:
          kind === 'systemone'
            ? 'System One models'
            : kind === 'decision'
              ? 'Decision models'
              : 'Chat models',
        models: items.filter((m) => {
          if (kind === 'systemone') return isSystemOneModel(m);
          if (kind === 'decision') return isDecisionModel(m);
          return isChattable(m);
        }),
      })),
    [items],
  );

  const q = query.trim().toLowerCase();
  /* flat navigation order mirrors the grouped render order */
  const shown = useMemo(() => {
    const all = groups.flatMap((g) => g.models);
    return q
      ? all.filter((m) => modelSearchText(m).toLowerCase().includes(q))
      : all;
  }, [groups, q]);

  const selected = items.find((m) => m.id === selectedId) ?? null;

  useEffect(() => {
    if (open) {
      setQuery('');
      setIdx(
        Math.max(
          0,
          (groups.flatMap((g) => g.models).length
            ? groups.flatMap((g) => g.models).map((m) => m.id)
            : []
          ).indexOf(selectedId),
        ),
      );
      searchRef.current?.focus({ preventScroll: true });
    }
  }, [open, selectedId, groups]);

  const label =
    status === 'loading' || status === 'idle'
      ? ''
      : selected
        ? selected.shortName
        : 'Select a model…';

  const trigger = (
    <button
      ref={anchor}
      type="button"
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-label="Select decision model"
      onClick={() => setOpen((o) => !o)}
      onAnimationEnd={() => setShaking(false)}
      className={`dec-model-btn${open ? ' is-open' : ''}${invalid ? ' err' : ''}${shaking ? ' shake' : ''}`}
    >
      {label === '' || !selected ? (
        <span className="dec-model-placeholder">Select a model…</span>
      ) : (
        <span className="dec-model-name">{label}</span>
      )}
      {selected?.kind && selected.kind !== 'llm' && (
        <span className="dec-model-tag">
          {selected.kind === 'systemone' ? 'SYS1' : 'DEC'}
        </span>
      )}
      {selected && <span className="dec-model-prov">{selected.provider}</span>}
      <I n="chevron-down-sm" s={12} w={2.4} className="shrink-0" />
    </button>
  );

  return (
    <>
      {selected ? (
        <Tip label={`${selected.id} · ${selected.provider}`} side="top">
          {trigger}
        </Tip>
      ) : (
        trigger
      )}
      <Popover
        open={open}
        anchor={anchor}
        onClose={(r) => {
          setOpen(false);
          if (r) anchor.current?.focus();
        }}
        placement="bottom-start"
        width={330}
        z={40}
      >
        <div className="flex flex-col">
          <input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-label="Search models"
            aria-activedescendant={
              shown[idx] ? `dmp-opt-${shown[idx].id}` : undefined
            }
            placeholder="Search models…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIdx((i) => Math.min(shown.length - 1, i + 1));
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIdx((i) => Math.max(0, i - 1));
              }
              if (e.key === 'Enter') {
                e.preventDefault();
                const m = shown[idx];
                if (m) {
                  actions.setDecisionModel(m.id);
                  setOpen(false);
                }
              }
            }}
            className="w-full border-b border-[var(--border)] bg-transparent px-3 py-2 text-[16px] outline-none placeholder:text-[var(--text-3)]"
          />
          <div
            id={listId}
            role="listbox"
            aria-label="Models"
            className="max-h-[320px] overflow-y-auto"
          >
            {groups.map((g) => {
              const filtered = g.models.filter((m) =>
                shown.some((s) => s.id === m.id),
              );
              if (filtered.length === 0) return null;
              return (
                <div key={g.kind}>
                  <div className="sticky top-0 bg-[var(--panel)] px-3 py-1 text-[10px] muted">
                    {g.label}
                  </div>
                  {filtered.map((m) => (
                    <DecisionModelOption
                      key={m.id}
                      m={m}
                      active={shown[idx]?.id === m.id}
                      selected={m.id === selectedId}
                      onHover={() =>
                        setIdx(shown.findIndex((s) => s.id === m.id))
                      }
                      onPick={() => {
                        actions.setDecisionModel(m.id);
                        setOpen(false);
                      }}
                    />
                  ))}
                </div>
              );
            })}
            {shown.length === 0 && (
              <div className="px-3 py-4 text-[12px] muted">
                {status === 'loading' || (isSyncing && items.length === 0) ? (
                  <span className="flex items-center justify-center gap-2 py-4">
                    <span className="block size-4 shrink-0 animate-spin rounded-full border-2 border-[var(--accent)] border-t-transparent" />
                    <span>Loading models…</span>
                  </span>
                ) : items.length === 0 ? (
                  'No models loaded.'
                ) : (
                  'No matching models.'
                )}
              </div>
            )}
          </div>
        </div>
      </Popover>
    </>
  );
}

function DecisionModelOption({
  m,
  active,
  selected,
  onHover,
  onPick,
}: {
  m: Model;
  active: boolean;
  selected: boolean;
  onHover: () => void;
  onPick: () => void;
}) {
  const kindTag =
    m.kind === 'systemone' || m.kind === 'decision' ? (
      <span className="shrink-0 rounded-[4px] bg-[var(--sunken)] px-1 text-[10px] muted">
        {m.kind === 'systemone' ? 'system one' : 'decision'}
      </span>
    ) : null;
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the search input (aria-activedescendant)
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the search input
    <div
      id={`dmp-opt-${m.id}`}
      role="option"
      aria-selected={selected}
      onMouseEnter={onHover}
      onClick={onPick}
      className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 ${
        active ? 'bg-[var(--sunken)]' : ''
      } ${selected ? 'shadow-[inset_2px_0_0_0_var(--accent)]' : ''}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 break-words text-[13px] font-medium">
            {m.shortName}
          </span>
          {kindTag}
          {m.status === 'error' && (
            <span className="text-[10px] text-[var(--danger)]">no key</span>
          )}
          {m.status === 'stale' && (
            <span className="text-[10px] text-[var(--warn)]">stale</span>
          )}
        </div>
        <div className="num text-[11px] muted">
          {m.provider} · {m.params ? `${m.params} · ` : ''}
          {ctxFmt(m.context.window)} ctx · ${m.pricing.input}/$
          {m.pricing.output} per M
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1" aria-hidden="true">
        {m.capabilities.vision && <I n="image" s={12} className="muted" />}
        {m.capabilities.fast && (
          <span className="rounded-[4px] bg-[var(--sunken)] px-1 text-[10px] muted">
            fast
          </span>
        )}
      </div>
      {selected && (
        <I n="check" s={13} className="shrink-0 text-[var(--accent)]" />
      )}
    </div>
  );
}

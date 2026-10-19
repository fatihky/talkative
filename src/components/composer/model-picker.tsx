/*
 * ModelPicker / ParamsButton — model choice and send-time parameters in
 * the composer footer.
 *
 * Business logic:
 * - only llm models are chattable; embedding/decision models stay in
 *   settings and never appear here.
 * - search matches short name, id, provider and capability keywords
 *   (vision, tools, decision, …); opening resets the
 *   query, focuses search, and highlights the current pick; arrows move
 *   and Enter selects.
 * - an explicit pick is the app-wide default for new chats
 *   (localStorage), and also applies to the chat being composed in; the
 *   footer says so on home. It is not the way to change one chat: that is
 *   "Change model…" in the chat's actions menu, via the chat-model dialog,
 *   which never touches the default. Reopening a chat preselects the model
 *   of its latest reply on screen without touching that default.
 * - options carry provider, size, context window, per-M pricing, and
 *   capability badges (thinking/vision/tools/fast, plus "no key" and
 *   "stale"); names wrap instead of truncating.
 * - the thinking control is built from the model's reported levels;
 *   switching models adopts the model's default reasoning level or
 *   clamps to the nearest supported one with a dismissible note.
 * - the params popover edits temperature/top_p/max output/seed
 *   overrides; a dirty dot and count show what deviates from model
 *   defaults, and Reset clears them.
 * - the scope radio decides how far overrides reach (message/chat/
 *   global); level and overrides persist across reloads.
 */
'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Link } from 'waku';
import { ctxFmt } from '../../lib/format';
import { I } from '../../lib/icons';
import { isChattable, modelSearchText } from '../../lib/models';
import { Popover, Tip } from '../../lib/popover';
import {
  actions,
  paramDirtyKeys,
  useDraftStore,
  useLayoutStore,
  useModelsStore,
  useSelectedModel,
  useUIStore,
} from '../../stores';
import type { Model, ParamScope, ThinkingLevel } from '../../types';
import { Kbd, SegmentedControl, Skeleton } from '../../ui/primitives';

const LEVEL_LABEL: Record<ThinkingLevel, string> = {
  off: 'off',
  low: 'low',
  medium: 'med',
  high: 'high',
};
const LEVEL_VALUE: Record<string, ThinkingLevel> = {
  off: 'off',
  low: 'low',
  med: 'medium',
  medium: 'medium',
  high: 'high',
};

/* ── ModelPicker ───────────────────────────────────────────────── */

export function ModelPicker() {
  const model = useSelectedModel();
  const status = useModelsStore((s) => s.status);
  const items = useModelsStore((s) => s.items);
  const open = useUIStore((s) => s.modelBarPopover) === 'model';
  const vw = useLayoutStore((s) => s.vw);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [idx, setIdx] = useState(0);
  const [query, setQuery] = useState('');
  const listId = 'mpb-model-list';

  const q = query.trim().toLowerCase();
  /* only llm models can chat; embedding/decision models show in settings only */
  const chattable = items.filter(isChattable);
  const shown = q
    ? chattable.filter((m) => modelSearchText(m).toLowerCase().includes(q))
    : chattable;

  useEffect(() => {
    if (open) {
      setQuery('');
      setIdx(
        Math.max(
          0,
          items.findIndex((m) => m.id === model?.id),
        ),
      );
      searchRef.current?.focus({ preventScroll: true });
    }
  }, [open, items, model?.id]);

  const label =
    status === 'loading' || status === 'idle'
      ? null
      : model
        ? vw < 768
          ? `${model.shortName.slice(0, 8)}…`
          : model.shortName
        : '—';

  const provider = model ? model.provider : null;

  const trigger = (
    <button
      ref={anchor}
      data-mpb-trigger="model"
      type="button"
      role="combobox"
      aria-expanded={open}
      aria-controls={open ? listId : undefined}
      aria-haspopup="listbox"
      aria-label="Select model"
      onClick={() => actions.openModelBarPopover('model')}
      className={`model-picker-btn max-w-[220px] ${open ? 'open' : ''} ${
        status === 'error' ? 'border-[var(--danger)]' : ''
      }`}
    >
      {label === null ? (
        <Skeleton w={60} h={10} />
      ) : (
        <span className="mp-main min-w-0">
          <span className="truncate">{label}</span>
          {provider && <span className="mp-provider">{provider}</span>}
        </span>
      )}
      <I n="chevron-down" s={13} className="caret shrink-0" />
    </button>
  );

  return (
    <>
      <Tip
        label={model ? `${model.id} · ${model.provider}` : 'Model'}
        side="top"
      >
        {trigger}
      </Tip>
      <Popover
        open={open}
        anchor={anchor}
        onClose={(r) => actions.closeModelBarPopover(r)}
        placement="top-start"
        width={330}
        z={40}
      >
        <div className="model-menu-search">
          <I n="search" s={14} />
          <input
            ref={searchRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-label="Search models"
            aria-activedescendant={
              shown[idx] ? `opt-${shown[idx]?.id}` : undefined
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
                  actions.setModel(m.id);
                  actions.closeModelBarPopover(true);
                }
              }
            }}
          />
        </div>
        <div
          id={listId}
          role="listbox"
          aria-label="Models"
          className="model-menu-scroll"
        >
          <ModelList
            shown={shown}
            idx={idx}
            query={q}
            chattableCount={chattable.length}
            setIdx={setIdx}
          />
        </div>
      </Popover>
    </>
  );
}

/* grouped model list: provider group headers above `.model-menu-item` rows */
function ModelList({
  shown,
  idx,
  query,
  chattableCount,
  setIdx,
}: {
  shown: Model[];
  idx: number;
  query: string;
  chattableCount: number;
  setIdx: (i: number) => void;
}) {
  if (shown.length === 0) {
    return (
      <div className="px-3 py-4 text-[12px] muted">
        {chattableCount === 0 ? 'No models loaded.' : 'No matching models.'}
      </div>
    );
  }
  /* group only when not searching; a query flattens the list */
  const groups: { provider: string; models: Model[] }[] = [];
  if (query) {
    groups.push({ provider: '', models: shown });
  } else {
    const byProvider = new Map<string, Model[]>();
    for (const m of shown) {
      const arr = byProvider.get(m.provider) ?? [];
      arr.push(m);
      byProvider.set(m.provider, arr);
    }
    for (const [provider, models] of byProvider) groups.push({ provider, models });
  }

  let i = -1;
  return (
    <>
      {groups.map((g) => (
        <div key={g.provider || 'all'}>
          {g.provider && <div className="model-menu-group">{g.provider}</div>}
          {g.models.map((m) => {
            i += 1;
            return (
              <ModelOption
                key={m.id}
                m={m}
                active={i === idx}
                onHover={() => setIdx(i)}
              />
            );
          })}
        </div>
      ))}
    </>
  );
}

function ModelOption({
  m,
  active,
  onHover,
}: {
  m: Model;
  active: boolean;
  onHover: () => void;
}) {
  const sel = useDraftStore((s) => s.modelId === m.id);
  const unavailable = m.status !== 'ok';
  return (
    // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the search input (aria-activedescendant)
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard selection is handled by the search input
    <div
      id={`opt-${m.id}`}
      role="option"
      aria-selected={sel}
      onMouseEnter={onHover}
      onClick={() => {
        actions.setModel(m.id);
        actions.closeModelBarPopover(true);
      }}
      className={`model-menu-item ${sel ? 'on' : ''} ${unavailable ? 'off' : ''} ${
        active ? 'bg-[var(--fg-soft)]' : ''
      }`}
    >
      <span className="mm-dot" aria-hidden="true" />
      <span className="mm-main">
        <span className="mm-name">
          {m.shortName}
          {m.status === 'error' && (
            <span className="ml-1.5 font-sans text-[10px] text-[var(--danger)]">
              no key
            </span>
          )}
          {m.status === 'stale' && (
            <span className="ml-1.5 font-sans text-[10px] text-[var(--warn)]">
              stale
            </span>
          )}
        </span>
        <span className="mm-provider">
          {m.provider}
          {m.params ? ` · ${m.params}` : ''}
          {m.context.window != null ? ` · ${ctxFmt(m.context.window)} ctx` : ''}
          {' · '}${m.pricing.input}/${m.pricing.output} per M
        </span>
      </span>
      <span className="mm-caps" aria-hidden="true">
        {m.capabilities.thinking && (
          <i title="Thinking">
            <I n="brain" s={10} />
          </i>
        )}
        {m.capabilities.vision && (
          <i title="Vision">
            <I n="vision" s={10} />
          </i>
        )}
        {m.capabilities.tools && (
          <i title="Tool use">
            <I n="wrench" s={10} />
          </i>
        )}
        {m.capabilities.decisions && (
          <i title="Decision support">
            <I n="decision" s={10} />
          </i>
        )}
        {m.capabilities.fast && (
          <i title="Fast">
            <I n="play" s={10} />
          </i>
        )}
      </span>
      <I n="check" s={13} className="mm-check shrink-0" />
    </div>
  );
}

/* ── ThinkingSetting (lives inside the params popover) ─────────── */

function ThinkingSetting() {
  const model = useSelectedModel();
  const level = useDraftStore((s) => s.thinkingLevel);
  const clampNote = useUIStore((s) => s.clampNote);
  const status = useModelsStore((s) => s.status);

  let body: ReactNode;
  if (status === 'loading' || status === 'idle') {
    body = <Skeleton w={90} h={10} />;
  } else if (!model) {
    return null;
  } else if (model.thinkingLevels === undefined) {
    body = (
      <span className="text-[12px] muted">
        Not reported by this provider — set manually in{' '}
        <Link
          to={`/settings/providers?model=${encodeURIComponent(model.id)}`}
          className="text-[var(--accent)] hover:underline"
          onClick={() => actions.closeModelBarPopover(false)}
        >
          Settings → Models
        </Link>
      </span>
    );
  } else if (
    !model.capabilities.thinking ||
    model.thinkingLevels.length === 0
  ) {
    body = (
      <span className="text-[12px] muted">
        {model.shortName} does not support extended thinking
      </span>
    );
  } else {
    body = (
      <>
        <SegmentedControl
          ariaLabel="Thinking level"
          value={LEVEL_LABEL[level] ?? 'med'}
          options={model.thinkingLevels.map((l) => ({
            value: LEVEL_LABEL[l] ?? l,
            label: LEVEL_LABEL[l] ?? l,
          }))}
          disabled={false}
          onChange={(v) => actions.setThinkingLevel(LEVEL_VALUE[v] ?? 'medium')}
        />
        {clampNote && (
          <div
            className="mt-1 flex items-center gap-1 text-[11px] text-[var(--warn)]"
            role="status"
          >
            {clampNote}
            <button
              type="button"
              className="muted hover:text-[var(--text)]"
              aria-label="Dismiss"
              onClick={() => actions.dismissClampNote()}
            >
              ✕
            </button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="mb-2 border-b border-[var(--border)] pb-2">
      <div className="sec-label mb-1 flex items-center gap-1">
        <I n="brain" s={12} /> Thinking effort
      </div>
      {body}
    </div>
  );
}

/* ── ExtraParams ───────────────────────────────────────────────── */

const PARAM_DEFS = [
  { key: 'temperature', label: 'temp', min: 0, max: 2, step: 0.1, dflt: 1 },
  { key: 'top_p', label: 'top_p', min: 0, max: 1, step: 0.05, dflt: 1 },
  {
    key: 'max_output',
    label: 'max out',
    min: 256,
    max: 64000,
    step: 256,
    dflt: 8000,
  },
  { key: 'seed', label: 'seed', min: 0, max: 999, step: 1, dflt: -1 },
] as const;

export function ParamsButton() {
  const overrides = useDraftStore((s) => s.paramOverrides);
  const scope = useDraftStore((s) => s.paramScope);
  const open = useUIStore((s) => s.modelBarPopover) === 'params';
  const anchor = useRef<HTMLButtonElement | null>(null);
  const dirty = paramDirtyKeys(overrides);
  const tip =
    dirty.length > 0 ? `Overridden: ${dirty.join(', ')}` : 'Extra parameters';

  const btn = (
    <button
      ref={anchor}
      data-mpb-trigger="params"
      type="button"
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label="Extra parameters"
      onClick={() => actions.openModelBarPopover('params')}
      className="ctl-icon relative size-7 border-transparent bg-transparent text-[var(--text-2)] hover:bg-[var(--sunken)] hover:text-[var(--text)]"
    >
      <I n="sliders" s={14} />
      {dirty.length > 0 && (
        <span
          className="absolute right-0.5 top-0.5 block size-[6px] rounded-full bg-[var(--accent)]"
          aria-hidden="true"
        />
      )}
    </button>
  );

  return (
    <>
      <Tip label={tip} side="bottom">
        {btn}
      </Tip>
      <Popover
        open={open}
        anchor={anchor}
        onClose={(r) => actions.closeModelBarPopover(r)}
        placement="top-start"
        width={280}
        z={40}
      >
        <div className="px-3 py-2">
          <ThinkingSetting />
          <div className="sec-label mb-1">Extra parameters</div>
          {PARAM_DEFS.map((d) => {
            const val = (overrides[d.key] as number | undefined) ?? d.dflt;
            return (
              <label
                key={d.key}
                className="mb-1.5 flex items-center gap-2 text-[12px]"
              >
                <span className="w-[52px] shrink-0 muted">{d.label}</span>
                <input
                  type="range"
                  min={d.min}
                  max={d.max}
                  step={d.step}
                  value={val}
                  aria-label={d.key}
                  onChange={(e) =>
                    actions.setParamOverride(d.key, Number(e.target.value))
                  }
                  className="h-1 flex-1 accent-[var(--accent)]"
                />
                <span className="num w-[46px] shrink-0 text-right">{val}</span>
              </label>
            );
          })}
          <div className="mt-2 flex items-center justify-between border-t border-[var(--border)] pt-2">
            <fieldset>
              <legend className="sr-only">Parameter scope</legend>
              <div className="flex items-center gap-2 text-[11px]">
                {(['message', 'chat', 'global'] as ParamScope[]).map((sc) => (
                  <label
                    key={sc}
                    className="flex cursor-pointer items-center gap-1"
                  >
                    <input
                      type="radio"
                      name="pp-scope"
                      checked={scope === sc}
                      onChange={() => actions.setParamScope(sc)}
                      className="accent-[var(--accent)]"
                    />
                    {sc}
                  </label>
                ))}
              </div>
            </fieldset>
            <button
              type="button"
              className="ctl h-6 px-2 text-[11px]"
              onClick={() => actions.resetParams()}
            >
              Reset
            </button>
          </div>
          <div className="num mt-1 flex items-center justify-between text-[11px] muted">
            <span>
              {dirty.length === 0
                ? 'All params at model defaults'
                : `${dirty.length} overridden`}
            </span>
            <Kbd>Ctrl⇧P</Kbd>
          </div>
        </div>
      </Popover>
    </>
  );
}

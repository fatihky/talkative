/*
 * ModelOverrideForm — the inline editor for one model's overrides, or for a
 * custom model being added. Each row mounts its own instance, so the fields,
 * the error and the saving state belong to that form alone: another row's
 * save or edit never touches it.
 *
 * Business logic:
 * - Saving PUTs only what differs from the catalog row, so a clear field
 *   never overwrites a value the provider reports.
 * - The form pins a few rules the server enforces too: thinking is on
 *   exactly when a level above "off" is selected, the default level must be
 *   one of the selected levels, and a custom model needs a connection and
 *   the upstream model name.
 * - On success the form calls onDone; the store has already reloaded the
 *   list by then.
 */
'use client';

import { type FormEvent, useState } from 'react';
import type { ModelOverrideBody } from '../lib/api';
import type {
  Model,
  ModelCapabilities,
  ModelKind,
  ThinkingLevel,
} from '../types';
import { actions } from '../stores';
import { errorText } from '../stores/models';

const LEVELS: ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'max'];
const CAPS = ['vision', 'tools', 'audio', 'json', 'fast', 'decisions'] as const;
const KINDS: ModelKind[] = ['llm', 'decision', 'systemone'];
const inputCls =
  'h-7 w-full rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] px-2 text-[12px] outline-none focus:border-[var(--accent)]';

/* a level list sorted least → most thinking, for display */
export const orderLevels = (l: ThinkingLevel[]) =>
  LEVELS.filter((x) => l.includes(x));

/* one badge per capability the row reports, in a fixed order, each with a
   tooltip: a missing badge means the model doesn't have it. The hint says
   what the flag actually buys, since a bare name doesn't tell you. */
export const CAP_BADGES = [
  {
    key: 'thinking',
    icon: 'brain',
    label: 'Thinking',
    hint: 'Sends a reasoning effort level with the request; the composer offers the levels listed on the row.',
  },
  {
    key: 'vision',
    icon: 'vision',
    label: 'Vision',
    hint: 'Accepts images: screenshots and pictures pasted or attached to the composer reach the model as image parts.',
  },
  {
    key: 'tools',
    icon: 'wrench',
    label: 'Tool use',
    hint: 'Can call tools (web search, GitHub, code execution, …): the tool bar offers them and the model may ask to run one.',
  },
  {
    key: 'audio',
    icon: 'audio',
    label: 'Audio input',
    hint: 'Accepts audio files as input alongside text and images.',
  },
  {
    key: 'json',
    icon: 'json',
    label: 'Structured output (JSON)',
    hint: 'Supports a JSON response format (response_format), so replies can be forced into a strict schema.',
  },
  {
    key: 'fast',
    icon: 'play',
    label: 'Fast',
    hint: 'A low-latency model, recommended for quick tasks: pickers prioritise it and the decision picker marks it as fast.',
  },
  {
    key: 'decisions',
    icon: 'decision',
    label: 'Decision support',
    hint: 'Can answer the decision endpoints (/decisions, /systemone), so it is offered as a decision model.',
  },
] as const satisfies readonly {
  key: keyof Model['capabilities'];
  icon: string;
  label: string;
  hint: string;
}[];

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
    /* adding a model always targets a connection: there is no catalog row to edit */
    custom: m === null || o?.custom === true,
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

export function ModelOverrideForm({
  initial,
  connections,
  onDone,
}: {
  /* the catalog row being edited, or null when adding a custom model */
  initial: Model | null;
  connections: { id: number; name: string }[];
  onDone: () => void;
}) {
  /* this form's own save: the store's `saving` is shared by every row */
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState<FormState>(() => toForm(initial, connections));
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Partial<FormState>) => setF((cur) => ({ ...cur, ...p }));

  /* the id the row is stored under: an edited row keeps its id, a new custom
     model gets the catalog id `${connectionId}:${upstream name}` — the same
     shape every model carries, with no `custom:` prefix anymore (old chats
     that hold one still resolve, server-side) */
  const modelId =
    initial?.id ??
    (f.connectionId && f.remoteId.trim()
      ? `${f.connectionId}:${f.remoteId.trim()}`
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
    const o = initial?.overrides;
    /* The PUT replaces the whole row, yet the form prefills from the merged
       row the override was already applied to: a field that is overridden
       prefills with the override, so comparing it to the row would call it
       unchanged and silently drop it on the next save. Compare against the
       catalog instead, and always re-send a field that is overridden —
       clearing it is how a single field is reset. */
    const count = (
      value: string,
      overridden: boolean,
      catalog: number | null,
    ): number | undefined => {
      const n = num(value);
      return n === undefined || (!overridden && n === catalog)
        ? undefined
        : n;
    };
    const word = (
      value: string,
      overridden: boolean,
      catalog: string | undefined,
    ): string | undefined => {
      const s = value.trim();
      return s && (overridden || s !== (catalog ?? '')) ? s : undefined;
    };
    /* Only a capability that differs from what the row already reports is
       sent: a box left alone says nothing, so a prefilled form never
       rewrites the catalog. The server merges this over the provider's
       flags, so `false` takes one away and the reset path is DELETE. An
       overridden flag has no catalog value to compare with, so it is
       always sent as shown. */
    const caps: Partial<ModelCapabilities> = Object.fromEntries(
      CAPS.filter(
        (k) =>
          o?.capabilities?.[k] !== undefined ||
          f.caps[k] !== (initial?.capabilities[k] ?? false),
      ).map((k) => [k, f.caps[k]]),
    );
    /* levels ride the same rule: an untouched provider list stays out, an
       overridden one is re-sent even when unchanged (an empty box is the
       real value "takes no effort") */
    const catalogLevels = initial?.thinkingLevels;
    const levels: ThinkingLevel[] | undefined =
      o?.thinkingLevels !== undefined ||
      (catalogLevels !== undefined
        ? catalogLevels.join() !== f.levels.join()
        : f.levels.length > 0)
        ? f.levels
        : undefined;
    const window = count(
      f.contextWindow,
      o?.contextWindow !== undefined,
      initial?.context.window ?? null,
    );
    const maxOutput = count(
      f.maxOutput,
      o?.maxOutput !== undefined,
      initial?.context.maxOutput ?? null,
    );
    const shortName = word(
      f.shortName,
      o?.shortName !== undefined,
      initial?.shortName,
    );
    const params = word(f.params, o?.params !== undefined, initial?.params);
    const price = (k: 'input' | 'cachedInput' | 'output'): number | undefined => {
      const n = num(f.pricing[k]);
      return n === undefined ||
        (o?.pricing?.[k] === undefined && n === initial?.pricing[k])
        ? undefined
        : n;
    };
    const pricing: Partial<Model['pricing']> = {};
    for (const k of ['input', 'cachedInput', 'output'] as const) {
      const n = price(k);
      if (n !== undefined) pricing[k] = n;
    }
    const dflt: ThinkingLevel | undefined =
      f.dflt &&
      (o?.defaultThinkingLevel !== undefined ||
        f.dflt !== initial?.defaultThinkingLevel)
        ? f.dflt
        : undefined;
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
      ...(levels !== undefined ? { thinkingLevels: levels } : {}),
      /* thinking is only claimed alongside the levels that offer it: the
         server derives it, and a body without levels can't carry it */
      ...(Object.keys(caps).length || (levels !== undefined && thinking)
        ? {
            capabilities: {
              ...caps,
              ...(levels !== undefined && thinking ? { thinking: true } : {}),
            },
          }
        : {}),
      ...(shortName ? { shortName } : {}),
      ...(window !== undefined ? { contextWindow: window } : {}),
      ...(maxOutput !== undefined ? { maxOutput } : {}),
      ...(dflt ? { defaultThinkingLevel: dflt } : {}),
      ...(params ? { params } : {}),
      pricing,
    };
    setSaving(true);
    try {
      await actions.save(modelId, body);
      onDone();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
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
          <label
            key={k}
            className="flex cursor-pointer items-center gap-1"
            title={CAP_BADGES.find((b) => b.key === k)?.hint}
          >
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

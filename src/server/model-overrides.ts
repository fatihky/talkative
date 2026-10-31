/*
 * ModelOverrides — per-user corrections and additions on top of the
 * catalog each provider reports.
 *
 * Business logic:
 * - a catalog is only as good as what the upstream admits: openai's
 *   spec exposes no capabilities, local runtimes report partial ones,
 *   and a model behind a proxy may simply be missing. an override
 *   fixes that per user, so it lives in model_overrides (user_id,
 *   model_id) rather than in the shared redis catalog.
 * - model_id is either a catalog id (`${connectionId}:${remoteId}`, the
 *   same string the composer sends) or, for a custom model, an id that
 *   doesn't parse — runs.ts then reads the custom row's remoteId,
 *   connectionId and baseUrl instead of splitting the id apart.
 * - every field is optional: only what the row carries is applied, so
 *   an override that sets just the context window leaves the
 *   provider's thinking levels alone. `hidden` is the one removal
 *   switch — a hidden model stays stored (with its other overrides) but
 *   drops out of the merged list.
 * - applyOverrides mutates the rows' `overrides` member in place (it
 *   already carries applied fields, so callers can see it's edited)
 *   and returns the flags a catalog row can't express: hidden and, for
 *   custom models, the connection/base url/remote id a run needs.
 * - the server is the authority on what custom models can do: parseInput
 *   forces kind to llm/decision/systemone and derives `thinking` from
 *   the levels, so a row can never claim thinking with no level to
 *   offer (which the composer treats as "none") or the reverse.
 * - resolveModel serves one model id for runs: a custom model as
 *   recorded, otherwise the catalog row with its overrides applied.
 */

import { and, eq } from 'drizzle-orm';
import { getDb } from '../db';
import type { ModelOverrideRow } from '../db/schema';
import { modelOverrides } from '../db/schema';
import type {
  Model,
  ModelCapabilities,
  ModelKind,
  ModelOverrideDto,
  ModelPricing,
  ThinkingLevel,
} from '../types';
import { ValidationError } from './errors';
import { parseModelId } from './model-id';

/* only these can be chosen for a custom model: embeddings can't chat and
   'llm' is the default, so anything else is a typo */
const KINDS = ['llm', 'decision', 'systemone'] as const;
const LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high'];

/* what a row can change about a model, all optional: unset = keep the provider's value */
export type ModelOverride = {
  shortName?: string | undefined;
  /* custom models only (there is no catalog row to inherit from) */
  kind?: ModelKind | undefined;
  contextWindow?: number | undefined;
  maxOutput?: number | undefined;
  thinkingLevels?: ThinkingLevel[] | undefined;
  defaultThinkingLevel?: ThinkingLevel | undefined;
  capabilities?: Partial<ModelCapabilities> | undefined;
  pricing?: Partial<ModelPricing> | undefined;
  params?: string | undefined;
  hidden: boolean;
  /* custom models only: the connection a run sends to, and an optional url override */
  connectionId?: number | undefined;
  remoteId?: string | undefined;
  baseUrl?: string | undefined;
};

/** flags a catalog Model can't carry; kept beside the item and never sent to the client */
export type ModelFlags = {
  hidden: boolean;
  /* custom models only: the connection they run against and the url to reach it */
  custom?: { connectionId: number; remoteId: string; baseUrl: string | undefined };
};

export type MergedCatalog = { items: Model[]; flags: Map<string, ModelFlags> };

export const isEmptyOverride = (o: ModelOverride): boolean =>
  Object.values(o).every((v) => v === undefined || v === null);

/* a capability block that only says what the provider already reports
   carries no override; a custom model's blank baseline is all-false, so
   sending it back is still "nothing set" */
export const isRedundantCapabilities = (
  caps: Partial<ModelCapabilities> | undefined,
  base: Partial<ModelCapabilities> | undefined,
): boolean =>
  caps !== undefined &&
  Object.entries(caps).every(([k, v]) => (base?.[k as keyof ModelCapabilities] ?? false) === v);

/* the client's view of a row: what settings shows and prefills from */
export const toDto = (o: ModelOverride): ModelOverrideDto => ({
  ...(o.connectionId !== undefined ? { custom: true } : {}),
  ...(o.connectionId !== undefined ? { connectionId: o.connectionId } : {}),
  ...(o.remoteId !== undefined ? { remoteId: o.remoteId } : {}),
  ...(o.baseUrl !== undefined ? { baseUrl: o.baseUrl } : {}),
  ...(o.kind !== undefined ? { kind: o.kind } : {}),
  ...(o.shortName !== undefined ? { shortName: o.shortName } : {}),
  ...(o.contextWindow !== undefined ? { contextWindow: o.contextWindow } : {}),
  ...(o.maxOutput !== undefined ? { maxOutput: o.maxOutput } : {}),
  ...(o.thinkingLevels !== undefined
    ? { thinkingLevels: o.thinkingLevels }
    : {}),
  ...(o.defaultThinkingLevel !== undefined
    ? { defaultThinkingLevel: o.defaultThinkingLevel }
    : {}),
  ...(o.params !== undefined ? { params: o.params } : {}),
  ...(o.capabilities !== undefined
    ? { capabilities: o.capabilities as ModelCapabilities }
    : {}),
  ...(o.pricing !== undefined ? { pricing: o.pricing as ModelPricing } : {}),
  hidden: o.hidden,
});

const toOverride = (r: ModelOverrideRow): ModelOverride => ({
  shortName: r.shortName ?? undefined,
  kind: (r.kind as ModelKind | null) ?? undefined,
  contextWindow: r.contextWindow ?? undefined,
  maxOutput: r.maxOutput ?? undefined,
  thinkingLevels: (r.thinkingLevels as ThinkingLevel[] | null) ?? undefined,
  defaultThinkingLevel: (r.defaultThinkingLevel as ThinkingLevel | null) ?? undefined,
  capabilities: r.capabilities ?? undefined,
  pricing: r.pricing ?? undefined,
  params: r.params ?? undefined,
  hidden: r.hidden,
  connectionId: r.connectionId ?? undefined,
  remoteId: r.remoteId ?? undefined,
  baseUrl: r.baseUrl ?? undefined,
});

/* the user's rows, keyed by the model id they override */
export const listOverrides = async (
  userId: string,
): Promise<Map<string, ModelOverride>> => {
  const rows = await getDb()
    .select()
    .from(modelOverrides)
    .where(eq(modelOverrides.userId, userId));
  return new Map(rows.map((r) => [r.modelId, toOverride(r)]));
};

/* applies what the override sets; undefined fields leave the provider's value */
const apply = <T>(m: Model, o: ModelOverride): Model => ({
  ...m,
  shortName: o.shortName ?? m.shortName,
  ...(o.kind ? { kind: o.kind } : {}),
  context: {
    window: o.contextWindow ?? m.context.window,
    maxOutput: o.maxOutput ?? m.context.maxOutput,
  },
  ...(o.thinkingLevels ? { thinkingLevels: o.thinkingLevels } : {}),
  ...(o.defaultThinkingLevel
    ? { defaultThinkingLevel: o.defaultThinkingLevel }
    : {}),
  ...(o.capabilities
    ? { capabilities: { ...m.capabilities, ...o.capabilities } }
    : {}),
  ...(o.pricing ? { pricing: { ...m.pricing, ...o.pricing } } : {}),
  ...(o.params !== undefined ? { params: o.params } : {}),
});

/* a user-added model has no catalog row to fall back on, so it starts blank */
const fromScratch = (id: string, provider: string, o: ModelOverride): Model => ({
  id,
  shortName: o.shortName ?? id,
  provider,
  kind: o.kind ?? 'llm',
  capabilities: {
    thinking: false,
    vision: false,
    tools: false,
    audio: false,
    json: false,
    fast: false,
    decisions: false,
    ...o.capabilities,
  },
  ...(o.thinkingLevels ? { thinkingLevels: o.thinkingLevels } : {}),
  ...(o.defaultThinkingLevel
    ? { defaultThinkingLevel: o.defaultThinkingLevel }
    : {}),
  context: { window: o.contextWindow ?? null, maxOutput: o.maxOutput ?? 0 },
  ...(o.params !== undefined ? { params: o.params } : {}),
  pricing: {
    input: 0,
    cachedInput: 0,
    output: 0,
    ...o.pricing,
  },
  status: 'ok',
  connectionId: o.connectionId,
  remoteId: o.remoteId,
});

/**
 * Folds the user's overrides into already-fetched catalog rows: edited
 * rows are rewritten in place, custom models are appended (grouped by
 * provider), hidden ones are dropped. `providerOf` names the connection
 * a custom model belongs to.
 */
export const applyOverrides = (
  items: Model[],
  overrides: Map<string, ModelOverride>,
  providerOf: (connectionId: number) => string | undefined,
): MergedCatalog => {
  const flags = new Map<string, ModelFlags>();
  const out: Model[] = items.flatMap((m) => {
    const o = overrides.get(m.id);
    if (!o) return [m];
    flags.set(m.id, { hidden: o.hidden });
    if (o.hidden) return [];
    return [apply(m, o)];
  });
  const known = new Set(items.map((m) => m.id));
  for (const [id, o] of overrides) {
    if (known.has(id) || o.hidden || o.connectionId === undefined) continue;
    const provider = providerOf(o.connectionId);
    if (!provider) continue;
    out.push(fromScratch(id, provider, o));
    flags.set(id, {
      hidden: false,
      custom: { connectionId: o.connectionId, remoteId: o.remoteId ?? id, baseUrl: o.baseUrl },
    });
  }
  return { items: out, flags };
};

/**
 * One model id as a run should see it: a custom model exactly as
 * recorded, otherwise the provider's row with the user's override
 * applied (undefined when nothing knows it). `fetchItems` is only
 * called for a catalog id, so a custom model never waits on upstream.
 */
export const resolveModel = async (
  userId: string,
  id: string,
  fetchItems: () => Promise<Model[]>,
  providerOf: (connectionId: number) => string | undefined,
): Promise<{ model: Model; custom?: ModelFlags['custom'] } | undefined> => {
  const overrides = await listOverrides(userId);
  const o = overrides.get(id);
  /* a row naming a connection is a model the provider never listed */
  if (o?.connectionId !== undefined) {
    if (o.hidden) return undefined;
    const provider = providerOf(o.connectionId) ?? String(o.connectionId);
    const custom = {
      connectionId: o.connectionId,
      remoteId: o.remoteId ?? id,
      baseUrl: o.baseUrl,
    };
    return { model: fromScratch(id, provider, o), custom };
  }
  if (!parseModelId(id)) return undefined;
  const found = (await fetchItems()).find((m) => m.id === id);
  if (!found || o?.hidden) return undefined;
  return { model: o ? apply(found, o) : found };
};

/* ---------- validation ---------- */

const isLevelList = (v: unknown): v is ThinkingLevel[] =>
  Array.isArray(v) &&
  v.length <= LEVELS.length &&
  v.every((l) => LEVELS.includes(l as ThinkingLevel)) &&
  new Set(v).size === v.length;

const bool = (v: unknown, key: string): boolean | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw new ValidationError(`${key} must be a boolean`);
  return v;
};

const count = (
  v: unknown,
  key: string,
  max: number,
): number | undefined | null => {
  if (v === undefined) return undefined;
  /* null is how the client says "back to what the provider reports" */
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max)
    throw new ValidationError(`${key} must be a number between 0 and ${max}`);
  return Math.round(v);
};

const perM = (v: unknown, key: string): number | undefined | null => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1_000_000)
    throw new ValidationError(`${key} must be a number between 0 and 1000000`);
  return v;
};

const url = (v: unknown): string | null | undefined => {
  if (v === undefined) return undefined;
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new ValidationError('baseUrl is not a valid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new ValidationError('baseUrl must be http(s)');
  return s.replace(/\/+$/, '');
};

export type OverrideInput = {
  base: { connectionId: number | null; remoteId: string | null; baseUrl: string | null };
  override: ModelOverride;
};

/**
 * Validates a PUT body: `custom` marks an added model (connectionId in
 * the body is then required and the row remembers remoteId/baseUrl),
 * otherwise the model id must be one the catalog names. Every other
 * field is optional; null and '' both mean "clear this override".
 */
export const parseInput = (id: string, body: unknown): OverrideInput => {
  const b = (body ?? {}) as Record<string, unknown>;
  const custom = b.custom === true;
  let connectionId: number | null = null;
  let remoteId: string | null = null;
  const baseUrl = url(b.baseUrl) ?? null;
  if (custom) {
    if (parseModelId(id))
      throw new ValidationError('a custom model id must not look like a catalog id');
    const c = b.connectionId;
    if (typeof c !== 'number' || !Number.isInteger(c) || c <= 0)
      throw new ValidationError('connectionId is required for a custom model');
    connectionId = c;
    const r = typeof b.remoteId === 'string' ? b.remoteId.trim() : '';
    if (!r) throw new ValidationError('remoteId is required for a custom model');
    remoteId = r;
  }

  const override: ModelOverride = {
    hidden: bool(b.hidden, 'hidden') ?? false,
    connectionId: connectionId ?? undefined,
    remoteId: remoteId ?? undefined,
    baseUrl: baseUrl ?? undefined,
  };

  if (b.shortName !== undefined) {
    const s = typeof b.shortName === 'string' ? b.shortName.trim() : '';
    if (s.length > 200)
      throw new ValidationError('shortName must be at most 200 characters');
    if (s) override.shortName = s;
  }
  if (b.kind !== undefined && b.kind !== null) {
    if (!KINDS.includes(b.kind as (typeof KINDS)[number]))
      throw new ValidationError(`kind must be one of: ${KINDS.join(', ')}`);
    override.kind = b.kind as ModelKind;
  }
  const window = count(b.contextWindow, 'contextWindow', 100_000_000);
  if (window) override.contextWindow = window;
  const maxOutput = count(b.maxOutput, 'maxOutput', 10_000_000);
  if (maxOutput) override.maxOutput = maxOutput;
  if (b.thinkingLevels !== undefined) {
    /* [] is a real value here: it says "this model takes no effort at all" */
    if (!isLevelList(b.thinkingLevels))
      throw new ValidationError(
        `thinkingLevels must be a subset of: ${LEVELS.join(', ')}`,
      );
    override.thinkingLevels = b.thinkingLevels;
  }
  if (b.defaultThinkingLevel !== undefined && b.defaultThinkingLevel !== null) {
    if (!LEVELS.includes(b.defaultThinkingLevel as ThinkingLevel))
      throw new ValidationError('defaultThinkingLevel must be off/low/medium/high');
    override.defaultThinkingLevel = b.defaultThinkingLevel as ThinkingLevel;
  }
  if (b.capabilities !== undefined && b.capabilities !== null) {
    if (typeof b.capabilities !== 'object' || Array.isArray(b.capabilities))
      throw new ValidationError('capabilities must be an object');
    const c = b.capabilities as Record<string, unknown>;
    const caps: Partial<ModelCapabilities> = {};
    for (const key of ['vision', 'tools', 'audio', 'json', 'fast', 'decisions'] as const) {
      const v = bool(c[key], `capabilities.${key}`);
      if (v !== undefined) caps[key] = v;
    }
    if (bool(c.thinking, 'capabilities.thinking') === true)
      caps.thinking = true;
    if (Object.keys(caps).length > 0) override.capabilities = caps;
  }
  if (b.pricing !== undefined && b.pricing !== null) {
    if (typeof b.pricing !== 'object' || Array.isArray(b.pricing))
      throw new ValidationError('pricing must be an object');
    const p = b.pricing as Record<string, unknown>;
    const pricing: Partial<ModelPricing> = {};
    for (const key of ['input', 'cachedInput', 'output', 'reasoning'] as const) {
      const v = perM(p[key], `pricing.${key}`);
      if (v !== undefined && v !== null) pricing[key] = v;
    }
    if (Object.keys(pricing).length > 0) override.pricing = pricing;
  }
  if (b.params !== undefined) {
    const s = typeof b.params === 'string' ? b.params.trim() : '';
    if (s.length > 32) throw new ValidationError('params must be at most 32 characters');
    if (s) override.params = s;
  }

  /* thinking is derived rather than typed: `thinking: true` with no level to
     offer would show the composer a reasoner it can't ask anything of */
  if (override.capabilities) {
    const on = (override.thinkingLevels ?? []).some((l) => l !== 'off');
    if (override.capabilities.thinking === true && !on)
      throw new ValidationError(
        'capabilities.thinking requires a thinkingLevels list with a level above off',
      );
    if (override.capabilities.thinking === undefined && on)
      override.capabilities.thinking = true;
  } else if (override.thinkingLevels?.some((l) => l !== 'off')) {
    override.capabilities = { thinking: true };
  }
  if (
    override.defaultThinkingLevel &&
    override.thinkingLevels &&
    !override.thinkingLevels.includes(override.defaultThinkingLevel)
  )
    throw new ValidationError('defaultThinkingLevel must be one of thinkingLevels');

  return {
    base: { connectionId, remoteId, baseUrl },
    override,
  };
};

/* ---------- writes ---------- */

export const saveOverride = async (
  userId: string,
  modelId: string,
  input: OverrideInput,
): Promise<void> => {
  const { base, override } = input;
  const db = getDb();
  /* every field the row sets; nulls clear what a previous save set */
  const value = {
    shortName: override.shortName ?? null,
    kind: override.kind ?? null,
    contextWindow: override.contextWindow ?? null,
    maxOutput: override.maxOutput ?? null,
    thinkingLevels: override.thinkingLevels ?? null,
    defaultThinkingLevel: override.defaultThinkingLevel ?? null,
    capabilities: (override.capabilities ?? null) as Record<
      string,
      boolean
    > | null,
    pricing: (override.pricing ?? null) as Record<string, number> | null,
    params: override.params ?? null,
    hidden: override.hidden,
    connectionId: base.connectionId,
    remoteId: base.remoteId,
    baseUrl: base.baseUrl,
  };
  const isCustom = base.connectionId !== null;
  if (!isCustom && isEmptyOverride(override)) {
    /* nothing left to override: forget the row instead of storing blanks */
    await removeOverride(userId, modelId);
    return;
  }
  await db
    .insert(modelOverrides)
    .values({ userId, modelId, ...value })
    .onConflictDoUpdate({
      target: [modelOverrides.userId, modelOverrides.modelId],
      set: { ...value, updatedAt: new Date() },
    });
};

export const removeOverride = async (userId: string, modelId: string) =>
  getDb()
    .delete(modelOverrides)
    .where(
      and(
        eq(modelOverrides.userId, userId),
        eq(modelOverrides.modelId, modelId),
      ),
    );

/* dropping a connection takes its overrides (and custom models) with it */
export const dropConnectionOverrides = async (connectionId: number) =>
  getDb()
    .delete(modelOverrides)
    .where(eq(modelOverrides.connectionId, connectionId));

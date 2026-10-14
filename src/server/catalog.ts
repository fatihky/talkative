/*
 * Catalog — per-connection model lists, fetched from each supported
 * provider compatibility and cached in redis.
 *
 * Business logic:
 * - connections live in postgres, model lists only in redis
 *   (`talkative:models:<connectionId>`); redis is strictly a
 *   cache — every failed read/write/del is logged and the operation
 *   carries on against upstream.
 * - getCatalog serves the cache for 10 min after a sync; past that
 *   (or with `refresh: true`, what ?refresh=1 passes) it refetches,
 *   keeping the old list up to 7 days as the fallback when upstream
 *   fails.
 * - the stored apiKey arrives sealed (`enc:…`); getCatalog opens it
 *   exactly once before handing the row to a fetcher, so fetchers and
 *   upstream only ever see plaintext.
 * - every upstream request identifies the app via identity.ts:
 *   user-agent everywhere, openrouter attribution headers on that
 *   compatibility.
 * - every model gets the namespaced id `${connectionId}:${remoteId}`,
 *   so the same remote model behind two connections stays distinct
 *   (model-id.ts parses it back).
 * - normalizeBaseUrl strips the per-compatibility api suffix (/v1,
 *   /api/v1, /api) so base urls typed with the prefix already on them
 *   still work.
 * - one fetcher per compatibility: openai GET /v1/models, openrouter
 *   GET /api/v1/models (links.next pagination, plus a System One pass
 *   for `output_modalities=decisions`), bifrost GET
 *   /v1/models (opaque page_token), lmstudio GET /api/v1/models,
 *   ollama GET /api/tags; pagination is capped at 20 pages so a
 *   misbehaving upstream can't loop forever, and each request times
 *   out after 10 s.
 * - capability mapping is per-provider best effort: the openai spec
 *   exposes nothing, so tools are assumed and thinking stays unknown;
 *   openrouter/bifrost derive caps from supported_parameters and
 *   input modalities; lm studio's binary "on" and ollama's boolean
 *   `think` map to off/medium, and lm studio decision models' vision
 *   is read from the top-level `has_vision_adapter` (they carry no
 *   `capabilities`); embedding-only ollama models are filtered out
 *   because they can't chat, and ollama's `decision` capability
 *   marks a model `kind: 'systemone'`.
 * - local servers (lmstudio, ollama) also surface architecture /
 *   quantization / format / size metadata; a loaded lm studio
 *   instance's context wins over max_context_length because it's
 *   what will actually be used.
 * - openrouter/bifrost prices arrive as USD-per-token strings and are
 *   converted to USD per 1M tokens; openrouter reasoning models get
 *   off/low/medium/high, bifrost reports its supported efforts plus
 *   a default.
 * - on upstream failure a cached list comes back with every model
 *   marked `stale` plus the error (empty list when there's no cache);
 *   a `[secrets] …` failure logs as error rather than warn because
 *   it's a keyring misconfiguration, not a dead server.
 * - invalidateCatalog runs on connection update or delete — url, key
 *   or compatibility may have changed, so the cached list is no
 *   longer trustworthy.
 * - startCatalogSweeper (optional, off by default) refetches every
 *   connection's list on a fixed interval so the redis cache stays
 *   warm without waiting for a client's ?refresh=1 to arrive. the
 *   interval is configured via CATALOG_REFRESH_MS (default 5 min); set
 *   CATALOG_REFRESH_MS=0 to disable. each tick refreshes in parallel,
 *   reusing getCatalog so a down provider only produces its logged
 *   stale/error path rather than failing the whole sweep.
 */
import type { ProviderConnectionRow } from '../db/schema';
import type {
  Compatibility,
  Model,
  ModelKind,
  ThinkingLevel,
} from '../types';
import { getRedis } from './redis';
import { decryptSecret } from './secrets';
import { OPENROUTER_ATTRIBUTION, USER_AGENT } from './identity';
import { providerConnections } from '../db/schema';
import { getDb } from '../db';
import { asc } from 'drizzle-orm';

/* model lists live in redis only; connections themselves live in postgres */
const KEY = (connectionId: number) => `talkative:models:${connectionId}`;
/* serve from cache while fresh; past that, refetch but keep the old list around as a stale fallback */
const FRESH_MS = 10 * 60 * 1000;
/* periodic refetch cadence; 0 disables the sweeper */
const DEFAULT_REFRESH_MS = 5 * 60 * 1000;
const KEEP_SEC = 7 * 24 * 60 * 60;
const FETCH_TIMEOUT_MS = 10_000;

export type CatalogEntry = {
  items: Model[];
  syncedAt: number;
  error?: string | undefined;
};

/* apiKey arrives sealed (`enc:…`); getCatalog opens it once before handing the row
   to a fetcher, so fetchers only ever see plaintext */
type Conn = Pick<
  ProviderConnectionRow,
  'id' | 'name' | 'baseUrl' | 'compatibility' | 'apiKey'
>;

/* tolerate base urls typed with the api prefix already on them */
const SUFFIXES: Record<Compatibility, RegExp> = {
  openai: /\/v1\/?$/,
  openrouter: /\/api(\/v1)?\/?$/,
  lmstudio: /\/api(\/v1)?\/?$/,
  ollama: /\/api\/?$/,
  bifrost: /\/v1\/?$/,
};

export const normalizeBaseUrl = (url: string, c: Compatibility): string =>
  url.trim().replace(/\/+$/, '').replace(SUFFIXES[c], '');

const getJson = async (url: string, conn: Conn) => {
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': USER_AGENT,
      /* attribution headers list the app in openrouter's rankings */
      ...(conn.compatibility === 'openrouter' ? OPENROUTER_ATTRIBUTION : {}),
      ...(conn.apiKey
        ? { authorization: `Bearer ${conn.apiKey}` }
        : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`GET ${url} → ${res.status}${body ? `: ${body}` : ''}`);
  }
  return (await res.json()) as unknown;
};

const NO_CAPS: Model['capabilities'] = {
  thinking: false,
  vision: false,
  tools: false,
  audio: false,
  json: false,
  fast: false,
  decisions: false,
};

const base = (conn: Conn, remoteId: string): Omit<Model, 'shortName'> => ({
  id: `${conn.id}:${remoteId}`,
  remoteId,
  connectionId: conn.id,
  provider: conn.name,
  kind: 'llm',
  capabilities: { ...NO_CAPS },
  context: { window: null, maxOutput: 0 },
  pricing: { input: 0, cachedInput: 0, output: 0 },
  status: 'ok',
});

/* ---------- openai: GET /v1/models → { data: [{ id }] } ---------- */

type OpenAIModel = {
  id: string;
  /* not part of the openai spec, but common on compatible servers (groq, vllm, …) */
  context_window?: number;
  max_model_len?: number;
  context_length?: number;
};

const fetchOpenAI = async (conn: Conn): Promise<Model[]> => {
  const json = (await getJson(`${conn.baseUrl}/v1/models`, conn)) as {
    data?: OpenAIModel[];
  };
  return (json.data ?? []).map((m) => ({
    ...base(conn, m.id),
    shortName: m.id,
    /* the spec exposes no capability info — thinking stays "unknown"; tools are assumed,
       since nearly every compatible server accepts them and errors clearly if not */
    capabilities: { ...NO_CAPS, tools: true, decisions: true },
    thinkingLevels: undefined,
    context: {
      window: m.context_window ?? m.max_model_len ?? m.context_length ?? null,
      maxOutput: 0,
    },
  }));
};

/* ---------- openrouter: GET /api/v1/models ---------- */

type OpenRouterModel = {
  id: string;
  name?: string;
  context_length?: number | null;
  architecture?: {
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    internal_reasoning?: string;
  };
  top_provider?: { max_completion_tokens?: number | null };
  supported_parameters?: string[];
};

/* openrouter prices are USD per token as strings; Model.pricing is USD per 1M tokens */
const perM = (v: string | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1e6 * 1e4) / 1e4 : 0;
};

const fetchOpenRouter = async (conn: Conn): Promise<Model[]> => {
  const out: Model[] = [];
  const seen = new Set<string>();
  /* follow links.next; capped so a misbehaving upstream can't loop forever.
     the default list is text-output models only; System One models (e.g. Jev)
     answer typed judgments, so they are fetched by their own modality and
     marked `kind: 'systemone'`. each remote id is kept once, text-first. */
  const collect = async (path: string, kind: ModelKind) => {
    let next: string | undefined = path;
    for (let page = 0; next && page < 20; page++) {
      const json = (await getJson(`${conn.baseUrl}${next}`, conn)) as {
        data?: OpenRouterModel[];
        links?: { next?: string | null };
      };
      for (const m of json.data ?? []) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        const params = new Set(m.supported_parameters ?? []);
        const inputs = new Set(m.architecture?.input_modalities ?? []);
        const reasoning = params.has('reasoning');
        const reasoningPrice = perM(m.pricing?.internal_reasoning);
        out.push({
          ...base(conn, m.id),
          kind,
          shortName: m.name ?? m.id,
          capabilities: {
            thinking: reasoning,
            vision: inputs.has('image'),
            tools: params.has('tools'),
            audio: inputs.has('audio'),
            json:
              params.has('response_format') || params.has('structured_outputs'),
            fast: false,
            decisions: true,
          },
          thinkingLevels: reasoning ? ['off', 'low', 'medium', 'high'] : [],
          context: {
            window: m.context_length ?? null,
            maxOutput: m.top_provider?.max_completion_tokens ?? 0,
          },
          pricing: {
            input: perM(m.pricing?.prompt),
            cachedInput: perM(m.pricing?.input_cache_read),
            output: perM(m.pricing?.completion),
            ...(reasoningPrice ? { reasoning: reasoningPrice } : {}),
          },
        });
      }
      next = json.links?.next ?? undefined;
    }
  };
  await collect('/api/v1/models', 'llm');
  await collect('/api/v1/models?output_modalities=decisions', 'systemone');
  return out;
};

/* ---------- bifrost: GET /v1/models ---------- */

type BifrostModel = {
  id: string;
  name?: string;
  normalized_name?: string;
  context_length?: number | null;
  max_output_tokens?: number | null;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    internal_reasoning?: string;
  };
  top_provider?: { max_completion_tokens?: number | null };
  supported_parameters?: string[];
  reasoning?: {
    mandatory?: boolean;
    default_enabled?: boolean;
    supported_efforts?: string[];
    default_effort?: string;
  };
};

const EFFORT_LEVELS: ThinkingLevel[] = ['low', 'medium', 'high'];

/* bifrost reports reasoning effort levels; unsupported values are ignored */
const toEffortLevels = (efforts: string[] | undefined): ThinkingLevel[] =>
  (efforts ?? []).filter((e): e is ThinkingLevel =>
    EFFORT_LEVELS.includes(e as ThinkingLevel),
  );

const fetchBifrost = async (conn: Conn): Promise<Model[]> => {
  const out: Model[] = [];
  let next: string | undefined = '/v1/models';
  for (let page = 0; next && page < 20; page++) {
    const json = (await getJson(`${conn.baseUrl}${next}`, conn)) as {
      data?: BifrostModel[];
      next_page_token?: string | null;
    };
    for (const m of json.data ?? []) {
      const params = new Set(m.supported_parameters ?? []);
      const inputs = new Set(m.architecture?.input_modalities ?? []);
      const reasoning = m.reasoning;
      const effortLevels = toEffortLevels(reasoning?.supported_efforts);
      /* a model with no selectable effort still reasons (mandatory/default) */
      const thinking =
        effortLevels.length > 0 ||
        reasoning?.mandatory === true ||
        reasoning?.default_enabled === true;
      out.push({
        ...base(conn, m.id),
        shortName: m.name || m.normalized_name || m.id,
        capabilities: {
          thinking,
          vision: inputs.has('image'),
          tools: params.has('tools'),
          audio: inputs.has('audio'),
          json:
            params.has('response_format') || params.has('structured_outputs'),
          fast: false,
          decisions: true,
        },
        thinkingLevels: thinking
          ? effortLevels.length > 0
            ? (['off', ...effortLevels] as ThinkingLevel[])
            : (['off', 'medium'] as ThinkingLevel[])
          : [],
        ...(reasoning?.default_effort !== undefined &&
        EFFORT_LEVELS.includes(reasoning.default_effort as ThinkingLevel)
          ? {
              defaultThinkingLevel: reasoning.default_effort as ThinkingLevel,
            }
          : {}),
        context: {
          window: m.context_length ?? null,
          maxOutput: m.top_provider?.max_completion_tokens ?? 0,
        },
        pricing: {
          input: perM(m.pricing?.prompt),
          cachedInput: perM(m.pricing?.input_cache_read),
          output: perM(m.pricing?.completion),
          ...(perM(m.pricing?.internal_reasoning) > 0
            ? { reasoning: perM(m.pricing?.internal_reasoning) }
            : {}),
        },
      });
    }
    /* page_token is opaque: build the follow-up url from the base path */
    if (json.next_page_token) {
      next = `/v1/models?page_token=${encodeURIComponent(json.next_page_token)}`;
    } else {
      next = undefined;
    }
  }
  return out;
};

/* ---------- lm studio: GET /api/v1/models ---------- */

type LMStudioOption = 'off' | 'on' | 'low' | 'medium' | 'high';
type LMStudioModel = {
  type: 'llm' | 'embedding' | 'decision';
  key: string;
  display_name?: string | null;
  architecture?: string | null;
  quantization?: { name?: string | null; bits_per_weight?: number | null } | null;
  size_bytes?: number;
  params_string?: string | null;
  loaded_instances?: { config?: { context_length?: number } }[];
  max_context_length?: number | null;
  format?: 'gguf' | 'mlx' | null;
  capabilities?: {
    vision?: boolean;
    trained_for_tool_use?: boolean;
    reasoning?: { allowed_options?: LMStudioOption[]; default?: LMStudioOption };
  };
  variants?: string[];
  selected_variant?: string;
  /* decision models only: whether the model has a vision adapter for image input */
  has_vision_adapter?: boolean;
};

const LEVEL_ORDER: ThinkingLevel[] = ['off', 'low', 'medium', 'high'];

/* lm studio's binary "on" has no effort level — treat it as medium */
const toLevels = (opts: LMStudioOption[]): ThinkingLevel[] => {
  const set = new Set(opts.map((o) => (o === 'on' ? 'medium' : o)));
  return LEVEL_ORDER.filter((l) => set.has(l));
};

/* "on" maps to medium, same as the allowed-options mapping */
const toLevel = (o: LMStudioOption): ThinkingLevel =>
  o === 'on' ? 'medium' : o;

const fetchLMStudio = async (conn: Conn): Promise<Model[]> => {
  const json = (await getJson(
    `${conn.baseUrl}/api/v1/models`,
    conn,
  )) as {
    models?: LMStudioModel[];
  };
  return (json.models ?? []).map((m) => {
    const caps = m.capabilities ?? {};
    const levels = caps.reasoning
      ? toLevels(caps.reasoning.allowed_options ?? [])
      : [];
    const dflt = caps.reasoning?.default;
    /* a loaded instance's configured context is what will actually be used */
    const loadedCtx = m.loaded_instances?.[0]?.config?.context_length;
    const quant = m.quantization?.name ?? undefined;
    const meta = {
      architecture: m.architecture ?? undefined,
      quantization: quant,
      format: m.format ?? undefined,
      sizeBytes: m.size_bytes ?? undefined,
      variants: m.variants?.length ? m.variants : undefined,
      selectedVariant: m.selected_variant ?? undefined,
    };
    return {
      ...base(conn, m.key),
      shortName: m.display_name || m.key,
      /* lm studio's `type: "decision"` models are TypeSafe System One models
         (Jev and friends); they answer /v1/systemone natively */
      kind: (m.type === 'decision' ? 'systemone' : m.type) satisfies ModelKind,
      capabilities: {
        ...NO_CAPS,
        thinking: levels.some((l) => l !== 'off'),
        /* decision models report no `capabilities`; their vision support arrives
           as the top-level `has_vision_adapter` flag instead */
        vision: caps.vision ?? m.has_vision_adapter ?? false,
        tools: caps.trained_for_tool_use ?? false,
        /* llm and decision models both decide; only embedding models can't */
        decisions: m.type !== 'embedding',
      },
      thinkingLevels: levels,
      ...(dflt !== undefined ? { defaultThinkingLevel: toLevel(dflt) } : {}),
      context: {
        window: loadedCtx ?? m.max_context_length ?? null,
        maxOutput: 0,
      },
      params: paramsFmt(m.params_string),
      meta,
    };
  });
};

/* ---------- ollama: GET /api/tags ---------- */

type OllamaModel = {
  name: string;
  model: string;
  /* not in the documented schema: context_length is returned by recent ollama versions */
  details?: {
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
    context_length?: number;
  };
  size?: number;
  capabilities?: string[];
};

const fetchOllama = async (conn: Conn): Promise<Model[]> => {
  const json = (await getJson(`${conn.baseUrl}/api/tags`, conn)) as {
    models?: OllamaModel[];
  };
  return (json.models ?? [])
    .filter((m) => {
      const caps = m.capabilities;
      /* embedding-only models can't chat */
      return (
        !caps || caps.includes('completion') || !caps.includes('embedding')
      );
    })
    .map((m) => {
      const caps = m.capabilities ? new Set(m.capabilities) : null;
      const thinking = caps?.has('thinking') ?? false;
      const meta = {
        architecture: m.details?.families?.length
          ? m.details.families.join(',')
          : m.details?.family,
        quantization: m.details?.quantization_level,
        format: m.details?.format,
        sizeBytes: m.size,
      };
      return {
        ...base(conn, m.model),
        shortName: m.name,
        /* `decision` marks a System One model (nimble, jev, tev, clef, …): it
           answers /v1/systemone natively; anything else is a chat llm */
        kind: caps?.has('decision')
          ? ('systemone' as const)
          : ('llm' as const),
        capabilities: {
          ...NO_CAPS,
          thinking,
          vision: caps?.has('vision') ?? false,
          tools: caps?.has('tools') ?? false,
          /* ollama has no /decisions endpoint; only System One (decision-capable)
             models answer /systemone */
          decisions: caps?.has('decision') ?? false,
        },
        /* ollama's `think` is a boolean toggle — expose it as off/medium like lm studio's "on";
           older servers don't report capabilities, so thinking stays unknown */
        thinkingLevels: caps
          ? thinking
            ? (['off', 'medium'] as ThinkingLevel[])
            : []
          : undefined,
        context: { window: m.details?.context_length ?? null, maxOutput: 0 },
        params: paramsFmt(m.details?.parameter_size),
        meta,
      };
    });
};

/* "8.0B" → "8B", "567.73M" → "568M"; anything unparseable passes through as-is */
const paramsFmt = (v: string | null | undefined): string | undefined => {
  const t = v?.trim();
  if (!t) return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*([KMBT])$/i.exec(t);
  if (!m) return t;
  const n = Number(m[1]);
  const num = n >= 100 ? Math.round(n) : Number(n.toFixed(1));
  return `${num}${m[2]?.toUpperCase()}`;
};

const FETCHERS: Record<Compatibility, (conn: Conn) => Promise<Model[]>> = {
  openai: fetchOpenAI,
  openrouter: fetchOpenRouter,
  lmstudio: fetchLMStudio,
  ollama: fetchOllama,
  bifrost: fetchBifrost,
};

/* ---------- cache ---------- */

const errorText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/* redis is a cache: if it's down, log and carry on against upstream */
const readCache = async (id: number): Promise<CatalogEntry | null> => {
  try {
    const raw = await getRedis().get(KEY(id));
    return raw ? (JSON.parse(raw) as CatalogEntry) : null;
  } catch (e) {
    console.warn(`[catalog] redis read failed: ${errorText(e)}`);
    return null;
  }
};

const writeCache = async (id: number, entry: CatalogEntry) => {
  try {
    await getRedis().set(KEY(id), JSON.stringify(entry), 'EX', KEEP_SEC);
  } catch (e) {
    console.warn(`[catalog] redis write failed: ${errorText(e)}`);
  }
};

export const invalidateCatalog = async (id: number) => {
  try {
    await getRedis().del(KEY(id));
  } catch (e) {
    console.warn(`[catalog] redis del failed: ${errorText(e)}`);
  }
};

/** models for one connection: redis while fresh, upstream otherwise, stale cache if upstream fails */
export const getCatalog = async (
  conn: Conn,
  opts: { refresh?: boolean } = {},
): Promise<CatalogEntry> => {
  const cached = await readCache(conn.id);
  if (!opts.refresh && cached && Date.now() - cached.syncedAt < FRESH_MS)
    return cached;
  try {
    const items = await FETCHERS[conn.compatibility]({
      ...conn,
      apiKey: decryptSecret(conn.apiKey),
    });
    const entry: CatalogEntry = { items, syncedAt: Date.now() };
    await writeCache(conn.id, entry);
    return entry;
  } catch (e) {
    const error = errorText(e);
    /* a decrypt failure is a config problem (missing keyring version), not an
       unreachable upstream — log it loudly so it isn't mistaken for a dead server */
    if (error.startsWith('[secrets]'))
      console.error(`[catalog] connection ${conn.id} (${conn.name}): ${error}`);
    else console.warn(`[catalog] connection ${conn.id} (${conn.name}): ${error}`);
    if (cached)
      return {
        items: cached.items.map((m) => ({ ...m, status: 'stale' as const })),
        syncedAt: cached.syncedAt,
        error,
      };
    return { items: [], syncedAt: Date.now(), error };
  }
};

/* ---------- periodic refetch ---------- */

const sweeperKey = Symbol.for('talkative:catalog-sweeper');

type SweeperState = { timer: NodeJS.Timeout };

const refreshMs = () => {
  const raw = process.env.CATALOG_REFRESH_MS?.trim();
  if (raw === undefined || raw === '') return DEFAULT_REFRESH_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_REFRESH_MS;
};

/* one tick: refresh every connection's cached list in parallel. connections carry
   all fields the fetchers need; getCatalog opens the sealed key itself. */
const sweep = async () => {
  try {
    const conns = await getDb()
      .select()
      .from(providerConnections)
      .orderBy(asc(providerConnections.id));
    await Promise.all(conns.map((c) => getCatalog(c, { refresh: true })));
  } catch (e) {
    console.warn(`[catalog] sweep failed: ${errorText(e)}`);
  }
};

/** start the optional background refetcher (idempotent; 0 disables). call once at server boot. */
export const startCatalogSweeper = () => {
  const g = globalThis as typeof globalThis & {
    [sweeperKey]?: SweeperState;
  };
  if (g[sweeperKey]) return;
  const ms = refreshMs();
  if (ms === 0) return;
  g[sweeperKey] = { timer: setInterval(sweep, ms) };
  if (typeof g[sweeperKey].timer.unref === 'function')
    g[sweeperKey].timer.unref();
};

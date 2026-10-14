/*
 * Decisions — one non-streaming `/decisions` round-trip per compatibility,
 * plus the parsing and shaping the /decisions routes are built on.
 *
 * Business logic:
 * - a decision run evaluates one shared `input` against a list of typed
 *   questions and gets one answer per question: a `predicate` probability,
 *   one of a `choice` question's values, or a `score` question's
 *   probability-weighted level index. DecisionQuestion/DecisionAnswer in
 *   types.ts are the canonical shapes; this module is the only place that
 *   knows how each provider spells them.
 * - openai, lm studio and bifrost all take the list form (`input` plus an
 *   ordered `questions` array) at `/v1/decisions`; openrouter's alpha
 *   endpoint is map form only, so questions go out keyed by name with
 *   `state` as the evidence, `noul` instead of `predicate`, a value →
 *   description map for choices and an ordered array of level descriptions
 *   for scores (a level's label survives only folded into its description).
 *   ollama has no OpenAI-style `/v1/decisions` endpoint — its decisions are
 *   served by /v1/systemone — and is rejected before any fetch for the
 *   `decision` kind.
 * - System One (run `kind: 'systemone'`) is the native TypeSafe protocol:
 *   `/v1/systemone` on lm studio and ollama, `/api/v1/systemone` on
 *   openrouter, in the same map form as openrouter's alpha endpoint. bifrost
 *   and openai don't expose it and are rejected. every System One answer
 *   normalizes back into the same canonical list shape.
 * - predicate `criteria` (what true/false mean) is sent to bifrost alone:
 *   it documents the field for its typesafe-backed models, while openai and
 *   lm studio would see an unknown key. answers never depend on it.
 * - the canonical shape is the list form, so answers are normalized back
 *   into it: openrouter's `noul` probability, its map-shaped
 *   `probabilities` and its `input_tokens`/`cost` usage all land in the
 *   same fields a list-form provider fills.
 * - an answer's type and name always come from the question that was asked,
 *   never from the response, so a provider that omits, reorders or renames
 *   them can't mislabel a result; a question with no answer at all reads as
 *   a refusal, and a response with no answers collection throws.
 * - score answers get a legend built from the question's own levels when the
 *   provider doesn't send one, so the UI can label every probability.
 * - parsing is strict and bounded (≤10 questions, ≤100k chars of input,
 *   2–20 choices, 2–10 levels, unique identifier-shaped names) because the
 *   whole run is stored verbatim and sent upstream as-is; every failure is a
 *   ValidationError → 400.
 * - conn.apiKey arrives sealed and is opened with decryptSecret per call; the
 *   bearer header is sent only when a key exists. a non-2xx throws
 *   `<connection name> → <status>: <body prefix>` so failures read by
 *   provider, and the caller's abort signal wins over the 60 s default.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '../db';
import type { DecisionRow, ProviderConnectionRow } from '../db/schema';
import { decisions } from '../db/schema';
import type {
  Compatibility,
  DecisionAnswer,
  DecisionChoice,
  DecisionKind,
  DecisionLevel,
  DecisionProbability,
  DecisionQuestion,
  DecisionRun,
  MessageUsage,
} from '../types';
import { isUuid } from './chats';
import { ValidationError } from './errors';
import { decryptSecret } from './secrets';

/* the OpenAI-style /decisions path per compatibility. ollama has none; null
   means "this compatibility can't serve this endpoint" */
const DECISIONS_PATH: Record<Compatibility, string | null> = {
  openai: '/v1/decisions',
  lmstudio: '/v1/decisions',
  bifrost: '/v1/decisions',
  openrouter: '/api/alpha/decisions',
  ollama: null,
};

/* the native TypeSafe System One /systemone path per compatibility. bifrost and
   openai don't expose it */
const SYSTEMONE_PATH: Record<Compatibility, string | null> = {
  openai: null,
  lmstudio: '/v1/systemone',
  bifrost: null,
  openrouter: '/api/v1/systemone',
  ollama: '/v1/systemone',
};

export const supportsDecisions = (c: Compatibility): boolean =>
  DECISIONS_PATH[c] !== null;

export const supportsSystemOne = (c: Compatibility): boolean =>
  SYSTEMONE_PATH[c] !== null;

/* the upstream path for a run kind; null means the compatibility can't serve it */
export const decisionPath = (
  c: Compatibility,
  kind: DecisionKind,
): string | null => (kind === 'systemone' ? SYSTEMONE_PATH[c] : DECISIONS_PATH[c]);

const MAX_QUESTIONS = 10;
const MAX_INPUT = 100_000;
const MAX_INSTRUCTIONS = 4_000;
const MAX_CRITERION = 1_000;
const MAX_TITLE = 255;
const MIN_CHOICES = 2;
const MAX_CHOICES = 20;
const MIN_LEVELS = 2;
const MAX_LEVELS = 10;
const DECISION_TIMEOUT_MS = 60_000;

/* a name is an answer key upstream, so it stays an identifier */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/* ---------- parsing ---------- */

const str = (v: unknown, field: string, max: number): string => {
  if (typeof v !== 'string')
    throw new ValidationError(`${field} must be a string`);
  const t = v.trim();
  if (!t) throw new ValidationError(`${field} must be non-empty`);
  if (t.length > max)
    throw new ValidationError(`${field} is too long (max ${max} characters)`);
  return t;
};

const optStr = (v: unknown, field: string, max: number): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string')
    throw new ValidationError(`${field} must be a string`);
  const t = v.trim();
  if (t.length > max)
    throw new ValidationError(`${field} is too long (max ${max} characters)`);
  return t === '' ? undefined : t;
};

const obj = (v: unknown, field: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new ValidationError(`${field} must be an object`);
  return v as Record<string, unknown>;
};

const parseCriteria = (
  v: unknown,
  field: string,
): DecisionQuestion['criteria'] | undefined => {
  if (v === undefined || v === null) return undefined;
  const c = obj(v, field);
  const t = optStr(c.true, `${field}.true`, MAX_CRITERION);
  const f = optStr(c.false, `${field}.false`, MAX_CRITERION);
  if (t === undefined && f === undefined) return undefined;
  return {
    ...(t !== undefined ? { true: t } : {}),
    ...(f !== undefined ? { false: f } : {}),
  };
};

const parseChoices = (v: unknown, field: string): DecisionChoice[] => {
  if (!Array.isArray(v))
    throw new ValidationError(`${field} is required for a choice question`);
  if (v.length < MIN_CHOICES || v.length > MAX_CHOICES)
    throw new ValidationError(
      `${field} must hold ${MIN_CHOICES}–${MAX_CHOICES} options`,
    );
  const seen = new Set<string>();
  return v.map((raw, j) => {
    const c = obj(raw, `${field}[${j}]`);
    const value = str(c.value, `${field}[${j}].value`, 100);
    if (seen.has(value))
      throw new ValidationError(`${field}[${j}].value "${value}" is a duplicate`);
    seen.add(value);
    const description = optStr(
      c.description,
      `${field}[${j}].description`,
      MAX_CRITERION,
    );
    return { value, ...(description !== undefined ? { description } : {}) };
  });
};

const parseLevels = (v: unknown, field: string): DecisionLevel[] => {
  if (!Array.isArray(v))
    throw new ValidationError(`${field} is required for a score question`);
  if (v.length < MIN_LEVELS || v.length > MAX_LEVELS)
    throw new ValidationError(
      `${field} must hold ${MIN_LEVELS}–${MAX_LEVELS} ordered levels`,
    );
  return v.map((raw, j) => {
    const l = obj(raw, `${field}[${j}]`);
    const label = str(l.label, `${field}[${j}].label`, 100);
    const description = optStr(
      l.description,
      `${field}[${j}].description`,
      MAX_CRITERION,
    );
    return { label, ...(description !== undefined ? { description } : {}) };
  });
};

const parseQuestion = (raw: unknown, i: number): DecisionQuestion => {
  const q = obj(raw, `questions[${i}]`);
  const type = q.type;
  if (type !== 'predicate' && type !== 'choice' && type !== 'score')
    throw new ValidationError(
      `questions[${i}].type must be predicate, choice or score`,
    );
  const name = str(q.name, `questions[${i}].name`, 64);
  if (!NAME_RE.test(name))
    throw new ValidationError(
      `questions[${i}].name must start with a letter or digit and contain only letters, digits, "_" and "-"`,
    );
  const instructions = str(
    q.instructions,
    `questions[${i}].instructions`,
    MAX_INSTRUCTIONS,
  );
  if (type === 'predicate') {
    const criteria = parseCriteria(q.criteria, `questions[${i}].criteria`);
    return { name, type, instructions, ...(criteria ? { criteria } : {}) };
  }
  if (type === 'choice')
    return {
      name,
      type,
      instructions,
      choices: parseChoices(q.choices, `questions[${i}].choices`),
    };
  return {
    name,
    type,
    instructions,
    levels: parseLevels(q.levels, `questions[${i}].levels`),
  };
};

export type DecisionRunInput = {
  /* client-minted uuid; an existing owned id re-runs that row instead of adding one */
  id?: string | undefined;
  modelId: string;
  title?: string | undefined;
  input: string;
  questions: DecisionQuestion[];
};

/** validates a POST /api/decisions body into the canonical run shape */
export const parseDecisionRun = (body: unknown): DecisionRunInput => {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.id !== undefined && (typeof b.id !== 'string' || !isUuid(b.id)))
    throw new ValidationError('id must be a uuid');
  const modelId = typeof b.modelId === 'string' ? b.modelId.trim() : '';
  if (!modelId) throw new ValidationError('modelId is required');
  if (typeof b.input !== 'string' || !b.input.trim())
    throw new ValidationError('input must be a non-empty string');
  if (b.input.length > MAX_INPUT)
    throw new ValidationError(`input is too long (max ${MAX_INPUT} characters)`);
  if (!Array.isArray(b.questions))
    throw new ValidationError('questions must be an array');
  if (b.questions.length === 0 || b.questions.length > MAX_QUESTIONS)
    throw new ValidationError(
      `questions must hold 1–${MAX_QUESTIONS} entries`,
    );
  const questions = b.questions.map(parseQuestion);
  const seen = new Set<string>();
  for (const q of questions) {
    if (seen.has(q.name))
      throw new ValidationError(`question name "${q.name}" is used twice`);
    seen.add(q.name);
  }
  const title = optStr(b.title, 'title', MAX_TITLE);
  return {
    ...(typeof b.id === 'string' ? { id: b.id } : {}),
    modelId,
    ...(title !== undefined ? { title } : {}),
    input: b.input,
    questions,
  };
};

/** validates a PATCH /api/decisions/:id body; only the title is editable */
export const parseDecisionPatch = (body: unknown): { title: string } => {
  const b = (body ?? {}) as Record<string, unknown>;
  return { title: str(b.title, 'title', MAX_TITLE) };
};

/* a run is titled after its evidence: the input's first non-empty line, else its
   first question — the list screen has nothing better to show */
export const deriveTitle = (
  input: string,
  questions: DecisionQuestion[],
): string => {
  const line = input
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '');
  const raw = line || questions[0]?.instructions || questions[0]?.name || '';
  const t = raw.trim() || 'Decision';
  return t.length > MAX_TITLE ? t.slice(0, MAX_TITLE - 1) + '…' : t;
};

/* ---------- upstream requests ---------- */

/* openai/lm studio/bifrost: an ordered array of typed questions. only bifrost
   documents predicate `criteria`, so it is left out elsewhere rather than risk
   a 400 on a field the provider doesn't know. */
const listRequest = (
  model: string,
  input: string,
  questions: DecisionQuestion[],
  withCriteria: boolean,
) => ({
  model,
  input,
  questions: questions.map((q) => ({
    type: q.type,
    name: q.name,
    instructions: q.instructions,
    ...(withCriteria && q.type === 'predicate' && q.criteria
      ? { criteria: q.criteria }
      : {}),
    ...(q.type === 'choice'
      ? {
          choices: (q.choices ?? []).map((c) => ({
            value: c.value,
            ...(c.description ? { description: c.description } : {}),
          })),
        }
      : {}),
    ...(q.type === 'score'
      ? {
          levels: (q.levels ?? []).map((l) => ({
            label: l.label,
            ...(l.description ? { description: l.description } : {}),
          })),
        }
      : {}),
  })),
});

/* openrouter's alpha endpoint is map form: `state` instead of `input`, questions
   keyed by name, `noul` instead of `predicate`, criteria as a value → description
   map (choice) or an ordered array of level descriptions (score) */
const mapRequest = (
  model: string,
  input: string,
  questions: DecisionQuestion[],
) => ({
  model,
  state: input,
  questions: Object.fromEntries(
    questions.map((q) => [
      q.name,
      q.type === 'predicate'
        ? {
            type: 'noul',
            instructions: q.instructions,
            /* both outcomes are required together, so a half-filled criteria is dropped */
            ...(q.criteria?.true && q.criteria?.false
              ? { criteria: { true: q.criteria.true, false: q.criteria.false } }
              : {}),
          }
        : q.type === 'choice'
          ? {
              type: 'choice',
              instructions: q.instructions,
              criteria: Object.fromEntries(
                (q.choices ?? []).map((c) => [c.value, c.description ?? '']),
              ),
            }
          : {
              type: 'score',
              instructions: q.instructions,
              /* the label rides along in the description: the map form has nowhere else for it */
              criteria: (q.levels ?? []).map((l) =>
                l.description ? `${l.label} — ${l.description}` : l.label,
              ),
            },
    ]),
  ),
});

/* ---------- upstream answers ---------- */

const num = (v: unknown): number | undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

const int = (v: unknown): number | undefined => {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n);
};

/* a distribution value is a choice's string or a level's index; booleans (bifrost
   allows them as choice values) read as their string form */
const distValue = (v: unknown): string | number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return String(v);
  return undefined;
};

const toProbabilities = (v: unknown): DecisionProbability[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out: DecisionProbability[] = [];
  for (const raw of v) {
    if (typeof raw !== 'object' || raw === null) continue;
    const p = raw as Record<string, unknown>;
    const probability = num(p.probability);
    const value = distValue(p.value);
    if (probability === undefined || value === undefined) continue;
    const label = typeof p.label === 'string' ? p.label : undefined;
    out.push({ value, probability, ...(label !== undefined ? { label } : {}) });
  }
  return out.length > 0 ? out : undefined;
};

/* openrouter reports a distribution as a map: keyed by choice value, or by level
   index for a score, where the levels supply the labels */
const mapProbabilities = (
  v: unknown,
  levels: DecisionLevel[] | undefined,
): DecisionProbability[] | undefined => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const out: DecisionProbability[] = [];
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    const probability = num(raw);
    if (probability === undefined) continue;
    const idx = Number(key);
    const level =
      levels !== undefined && Number.isInteger(idx) && idx >= 0
        ? levels[idx]
        : undefined;
    out.push({
      value: level ? idx : key,
      probability,
      ...(level ? { label: level.label } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
};

const toLegend = (v: unknown): Record<string, string> | undefined => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>))
    if (typeof raw === 'string') out[k] = raw;
  return Object.keys(out).length > 0 ? out : undefined;
};

/* level index → label from the question itself, for providers that send no legend */
const levelLegend = (
  levels: DecisionLevel[] | undefined,
): Record<string, string> | undefined => {
  if (!levels || levels.length === 0) return undefined;
  return Object.fromEntries(levels.map((l, i) => [String(i), l.label]));
};

/* the question decides the answer's name and type; a missing answer reads as a refusal */
const toAnswer = (
  q: DecisionQuestion,
  raw: Record<string, unknown> | null,
  mapForm: boolean,
): DecisionAnswer => {
  const refused =
    raw === null || raw.type === 'refusal' || raw.kind === 'refusal';
  if (refused) return { name: q.name, type: 'refusal' };
  if (q.type === 'predicate') {
    /* openrouter's noul answer carries its probability under `noul` */
    const probability = num(mapForm ? raw.noul : raw.probability);
    return {
      name: q.name,
      type: 'predicate',
      ...(probability !== undefined ? { probability } : {}),
    };
  }
  const confidence = num(raw.confidence);
  const probabilities = mapForm
    ? mapProbabilities(raw.probabilities, q.levels)
    : toProbabilities(raw.probabilities);
  if (q.type === 'choice') {
    const choice = distValue(raw.choice);
    return {
      name: q.name,
      type: 'choice',
      ...(choice !== undefined ? { choice: String(choice) } : {}),
      ...(probabilities ? { probabilities } : {}),
      ...(confidence !== undefined ? { confidence } : {}),
    };
  }
  const score = num(raw.score) ?? num(raw.value);
  const legend = toLegend(raw.legend) ?? levelLegend(q.levels);
  return {
    name: q.name,
    type: 'score',
    ...(score !== undefined ? { score } : {}),
    ...(probabilities ? { probabilities } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(legend ? { legend } : {}),
  };
};

const rawAnswer = (
  answers: unknown,
  questions: DecisionQuestion[],
  i: number,
  mapForm: boolean,
): Record<string, unknown> | null => {
  const q = questions[i];
  if (!q) return null;
  if (mapForm) {
    const a = (answers as Record<string, unknown>)[q.name];
    return typeof a === 'object' && a !== null
      ? (a as Record<string, unknown>)
      : null;
  }
  const list = answers as unknown[];
  /* answers arrive in question order; match by name first so a provider that
     drops one doesn't shift every later answer onto the wrong question */
  const a =
    list.find(
      (x) =>
        typeof x === 'object' &&
        x !== null &&
        (x as Record<string, unknown>).name === q.name,
    ) ?? list[i];
  return typeof a === 'object' && a !== null ? (a as Record<string, unknown>) : null;
};

/* openai/lm studio/bifrost report openai-style usage; openrouter's alpha answers
   report input_tokens/output_tokens and a flat cost instead */
const toUsage = (payload: unknown): MessageUsage | undefined => {
  const u = (payload as { usage?: unknown } | null)?.usage;
  if (typeof u !== 'object' || u === null) return undefined;
  const raw = u as Record<string, unknown>;
  const promptTokens = int(raw.prompt_tokens) ?? int(raw.input_tokens);
  const completionTokens = int(raw.completion_tokens) ?? int(raw.output_tokens);
  const costField = raw.cost;
  /* bifrost nests its breakdown under usage.cost, openrouter reports a number */
  const costUsd =
    num(
      typeof costField === 'object' && costField !== null
        ? (costField as Record<string, unknown>).total_cost
        : costField,
    ) ?? undefined;
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    costUsd === undefined
  )
    return undefined;
  const prompt = promptTokens ?? 0;
  const completion = completionTokens ?? 0;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: int(raw.total_tokens) ?? prompt + completion,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
};

/** the answers one upstream response holds, in question order, in the canonical shape */
export const normalizeAnswers = (
  questions: DecisionQuestion[],
  payload: unknown,
  mapForm: boolean,
): DecisionAnswer[] => {
  const answers = (payload as { answers?: unknown } | null)?.answers;
  const ok = mapForm
    ? typeof answers === 'object' && answers !== null && !Array.isArray(answers)
    : Array.isArray(answers);
  if (!ok) throw new Error('upstream returned no answers');
  return questions.map((q, i) =>
    toAnswer(q, rawAnswer(answers, questions, i, mapForm), mapForm),
  );
};

export type DecisionOutcome = {
  answers: DecisionAnswer[];
  usage?: MessageUsage | undefined;
  latencyMs: number;
};

/* one non-streaming round-trip against either endpoint; `kind` picks /decisions
   (OpenAI-style) or /systemone (native TypeSafe), both of which the map form
   spells the same way. throws on an unsupported combo or a non-2xx. */
export const runDecision = async (
  conn: ProviderConnectionRow,
  req: { model: string; input: string; questions: DecisionQuestion[] },
  opts: { timeoutMs?: number; signal?: AbortSignal; kind?: DecisionKind } = {},
): Promise<DecisionOutcome> => {
  const kind = opts.kind ?? 'decision';
  const path = decisionPath(conn.compatibility, kind);
  if (!path)
    throw new ValidationError(
      `${conn.name} does not support ${
        kind === 'systemone' ? 'System One' : 'decisions'
      }`,
    );
  /* the map form is how openrouter's decisions and every System One endpoint
     spell questions; the list form is the OpenAI-style /v1/decisions shape */
  const mapForm = kind === 'systemone' || conn.compatibility === 'openrouter';
  const payload = mapForm
    ? mapRequest(req.model, req.input, req.questions)
    : listRequest(
        req.model,
        req.input,
        req.questions,
        conn.compatibility === 'bifrost',
      );
  const apiKey = decryptSecret(conn.apiKey);
  const started = Date.now();
  const res = await fetch(`${conn.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? DECISION_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`${conn.name} → ${res.status}${body ? `: ${body}` : ''}`);
  }
  const json = (await res.json()) as unknown;
  const usage = toUsage(json);
  return {
    answers: normalizeAnswers(req.questions, json, mapForm),
    ...(usage ? { usage } : {}),
    latencyMs: Date.now() - started,
  };
};

/* ---------- dto ---------- */

export const toDecisionDto = (r: DecisionRow): DecisionRun => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  modelId: r.modelId,
  input: r.input,
  questions: (r.questions as DecisionQuestion[] | null) ?? [],
  ...(r.answers !== null ? { answers: r.answers as DecisionAnswer[] } : {}),
  ...(r.error ? { error: r.error } : {}),
  ...(r.usage !== null ? { usage: r.usage as MessageUsage } : {}),
  ...(r.latencyMs !== null ? { latencyMs: r.latencyMs } : {}),
  createdAt: r.createdAt.getTime(),
  updatedAt: r.updatedAt.getTime(),
});

export const decisionNotFound = () =>
  Response.json({ error: 'decision not found' }, { status: 404 });

/* ---------- queries ---------- */

/** one run scoped to its owner; a foreign or unknown id reads as null (→ 404) */
export const findDecision = (db: Db, userId: string, id: string) =>
  db
    .select()
    .from(decisions)
    .where(and(eq(decisions.id, id), eq(decisions.userId, userId)))
    .then((rows) => rows[0] ?? null);

/** the user's runs, newest first; the cap keeps the /decisions list bounded */
export const listDecisions = (db: Db, userId: string, limit = 200) =>
  db
    .select()
    .from(decisions)
    .where(eq(decisions.userId, userId))
    .orderBy(desc(decisions.createdAt))
    .limit(limit);

/** does any row already hold this id, whoever owns it; ids are primary keys */
export const decisionIdTaken = async (db: Db, id: string) => {
  const rows = await db
    .select({ id: decisions.id })
    .from(decisions)
    .where(eq(decisions.id, id))
    .limit(1);
  return rows.length > 0;
};

/*
 * telemetry — the app's own OpenTelemetry spans, metrics and log events for
 * inference, on top of the auto-instrumentation preloaded by
 * instrumentation.mjs.
 *
 * Business logic:
 * - follows the OpenTelemetry GenAI semantic conventions. a reply's trace:
 *
 *     invoke_agent talkative              (INTERNAL, new trace root)
 *     ├─ talkative.prepare                connection, model, reasoning effort
 *     ├─ chat <model>                     (CLIENT) one per completion round-trip
 *     │  └─ POST                          undici fetch to the provider
 *     ├─ execute_tool <name>              (INTERNAL) one per tool call
 *     │  └─ GET / POST …                  the tool's own requests
 *     ├─ chat <model>                     the next step, after the tool results
 *     └─ talkative.finalize               the final message/chat writes
 *
 *   classification gets its own `chat <model>` spans, and decisions and
 *   System One requests get `decision <model>` / `systemone <model>`.
 * - a reply runs detached from the request that started it, so its span is
 *   a new trace root linked to the request span instead of a child that
 *   outlives its parent by minutes. the once-a-second progress flushes run
 *   outside the trace (untraced) so a long reply isn't buried in UPDATEs.
 * - metrics: gen_ai.client.token.usage, gen_ai.client.operation.duration,
 *   gen_ai.client.operation.time_to_first_chunk and
 *   gen_ai.client.operation.time_per_output_chunk (spec names and buckets),
 *   plus talkative.tool.duration, talkative.agent.runs and
 *   talkative.agent.runs.active.
 * - logs: a `gen_ai.client.operation.exception` event for every failed
 *   completion, `talkative.tool.error` for failed tool calls and one
 *   `talkative.agent.run` summary per reply, each correlated with its span.
 *   they're printed to the console too (one line, like the rest of the app).
 * - message/tool content is recorded only when
 *   OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT asks for it (the
 *   variable the upstream GenAI instrumentations read): `true`/`SPAN_ONLY`
 *   put it on span attributes, `EVENT_ONLY` on a
 *   `gen_ai.client.inference.operation.details` log event, `SPAN_AND_EVENT`
 *   on both. images become a placeholder, each text part is capped, and api
 *   keys never reach telemetry.
 * - a user stop isn't an error: the span keeps an unset status and carries
 *   talkative.cancelled=true. timeouts and upstream failures are errors
 *   with a low-cardinality error.type (http status, `timeout`, …).
 * - everything is a no-op when the SDK isn't running (OTEL_SDK_DISABLED or
 *   a script started without the preload): @opentelemetry/api hands out
 *   no-op tracers, meters and loggers.
 */
import {
  type Attributes,
  type Context,
  type Counter,
  context,
  type Histogram,
  type Link,
  logs,
  metrics,
  ROOT_CONTEXT,
  SeverityNumber,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
  type UpDownCounter,
} from '@opentelemetry/api';
import type { ProviderConnectionRow } from '../db/schema';

const SCOPE = 'talkative';

const tracer = () => trace.getTracer(SCOPE);

/* ---------- content capture ---------- */

type Capture = { span: boolean; event: boolean };

/* opt-in, same switch (and values) the upstream GenAI instrumentations read */
export const contentCapture = (): Capture => {
  const v =
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT?.trim().toUpperCase() ??
    '';
  if (v === 'TRUE' || v === 'SPAN_ONLY') return { span: true, event: false };
  if (v === 'EVENT_ONLY') return { span: false, event: true };
  if (v === 'SPAN_AND_EVENT') return { span: true, event: true };
  return { span: false, event: false };
};
const capturing = (c: Capture) => c.span || c.event;

const PART_MAX = 8000;
const clip = (s: string): string =>
  s.length > PART_MAX
    ? `${s.slice(0, PART_MAX)}…[${s.length - PART_MAX} more]`
    : s;

type WireCall = { id: string; function: { name: string; arguments: string } };
type WireTurn = {
  role: string;
  content?: unknown;
  tool_calls?: WireCall[] | undefined;
  tool_call_id?: string;
};

/* openai chat turns → the GenAI semconv message/parts shape */
const toMessages = (turns: readonly WireTurn[]) =>
  turns.map((t) => {
    const parts: Record<string, unknown>[] = [];
    if (t.role === 'tool')
      parts.push({
        type: 'tool_call_response',
        id: t.tool_call_id,
        response: clip(String(t.content ?? '')),
      });
    else if (typeof t.content === 'string')
      parts.push({ type: 'text', content: clip(t.content) });
    else if (Array.isArray(t.content))
      for (const p of t.content as { type: string; text?: string }[])
        parts.push(
          p.type === 'text'
            ? { type: 'text', content: clip(p.text ?? '') }
            : { type: 'uri', modality: 'image', uri: '[image omitted]' },
        );
    for (const c of t.tool_calls ?? [])
      parts.push({
        type: 'tool_call',
        id: c.id,
        name: c.function.name,
        arguments: clip(c.function.arguments),
      });
    return { role: t.role, parts };
  });

/* ---------- metrics ---------- */

/* bucket boundaries from the GenAI metrics spec */
const TOKEN_BUCKETS = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304,
  16777216, 67108864,
];
const DURATION_BUCKETS = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48,
  40.96, 81.92, 163.84, 327.68,
];
const CHUNK_BUCKETS = [
  0.01, 0.025, 0.05, 0.075, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.75, 1.0, 2.5,
];

type Instruments = {
  tokens: Histogram;
  duration: Histogram;
  firstChunk: Histogram;
  perChunk: Histogram;
  tool: Histogram;
  runs: Counter;
  active: UpDownCounter;
};

/* created on first use: the meter provider is registered by the preload, and a
   meter taken before that would stay a no-op forever */
let instruments: Instruments | undefined;
const meters = (): Instruments => {
  if (instruments) return instruments;
  const m = metrics.getMeter(SCOPE);
  instruments = {
    tokens: m.createHistogram('gen_ai.client.token.usage', {
      description: 'Number of input and output tokens used',
      unit: '{token}',
      advice: { explicitBucketBoundaries: TOKEN_BUCKETS },
    }),
    duration: m.createHistogram('gen_ai.client.operation.duration', {
      description: 'GenAI operation duration',
      unit: 's',
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),
    firstChunk: m.createHistogram(
      'gen_ai.client.operation.time_to_first_chunk',
      {
        description:
          'Time from sending a streamed request to receiving its first chunk',
        unit: 's',
        advice: { explicitBucketBoundaries: DURATION_BUCKETS },
      },
    ),
    perChunk: m.createHistogram(
      'gen_ai.client.operation.time_per_output_chunk',
      {
        description: 'Time between consecutive chunks of a streamed response',
        unit: 's',
        advice: { explicitBucketBoundaries: CHUNK_BUCKETS },
      },
    ),
    tool: m.createHistogram('talkative.tool.duration', {
      description: 'Tool call duration',
      unit: 's',
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),
    runs: m.createCounter('talkative.agent.runs', {
      description: 'Assistant replies finished, by final status',
      unit: '{run}',
    }),
    active: m.createUpDownCounter('talkative.agent.runs.active', {
      description: 'Assistant replies currently generating',
      unit: '{run}',
    }),
  };
  return instruments;
};

/* the low-cardinality subset that goes on metrics */
const METRIC_KEYS = [
  'gen_ai.operation.name',
  'gen_ai.provider.name',
  'gen_ai.request.model',
  'gen_ai.response.model',
  'server.address',
  'server.port',
  'error.type',
] as const;
const pick = (a: Attributes): Attributes => {
  const out: Attributes = {};
  for (const k of METRIC_KEYS) if (a[k] !== undefined) out[k] = a[k];
  return out;
};

/* ---------- logs ---------- */

type Level = 'debug' | 'info' | 'warn' | 'error';
const SEVERITY: Record<Level, SeverityNumber> = {
  debug: SeverityNumber.DEBUG,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
  error: SeverityNumber.ERROR,
};

/* the unpatched console from instrumentation.mjs; console itself is mirrored
   into OTel logs there, and these records must not be emitted twice */
const rawConsole = (): Record<Level, (...a: unknown[]) => void> =>
  ((globalThis as Record<symbol, unknown>)[
    Symbol.for('talkative.otel.rawConsole')
  ] as Record<Level, (...a: unknown[]) => void> | undefined) ?? console;

/** prints to the console without mirroring into OTel logs (lines that carry user content) */
export const printLocal = (level: Level, ...args: unknown[]) =>
  rawConsole()[level](...args);

/* scalar attributes as `k=v` for the console line */
const consoleLine = (body: string, a: Attributes): string => {
  const kv = Object.entries(a)
    .filter(
      ([k, v]) =>
        v !== undefined &&
        typeof v !== 'object' &&
        !k.startsWith('gen_ai.input') &&
        !k.startsWith('gen_ai.output') &&
        k !== 'exception.stacktrace',
    )
    .map(
      ([k, v]) =>
        `${k}=${typeof v === 'string' && /\s/.test(v) ? JSON.stringify(v) : v}`,
    );
  return kv.length ? `${body} ${kv.join(' ')}` : body;
};

/**
 * a structured log record, correlated with `ctx` (default: the active span).
 * `print: false` keeps it out of the console (content-bearing events).
 */
export const emitLog = (
  level: Level,
  body: string,
  opts: {
    event?: string;
    attributes?: Attributes;
    ctx?: Context;
    print?: boolean;
  } = {},
) => {
  const attributes = opts.attributes ?? {};
  if (opts.print !== false) rawConsole()[level](consoleLine(body, attributes));
  logs.getLogger(SCOPE).emit({
    severityNumber: SEVERITY[level],
    severityText: level.toUpperCase(),
    body,
    attributes,
    context: opts.ctx ?? context.active(),
    ...(opts.event ? { eventName: opts.event } : {}),
  });
};

/* ---------- shared bits ---------- */

const serverAttrs = (baseUrl: string): Attributes => {
  try {
    const u = new URL(baseUrl);
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    return { 'server.address': u.hostname, 'server.port': port };
  } catch {
    return {};
  }
};

const providerAttrs = (conn: ProviderConnectionRow): Attributes => ({
  'gen_ai.provider.name': conn.compatibility,
  'talkative.provider.connection_id': conn.id,
  'talkative.provider.connection_name': conn.name,
  ...serverAttrs(conn.baseUrl),
});

/* a failed completion tags its error with the error.type it was recorded under,
   so the reply that dies of it reports the same type */
const ERROR_TYPE = Symbol.for('talkative.otel.errorType');

/** low-cardinality error.type for an exception */
export const errorType = (e: unknown): string => {
  if (e instanceof Error) {
    const tagged = (e as Error & { [ERROR_TYPE]?: string })[ERROR_TYPE];
    if (tagged) return tagged;
    if (e.name === 'TimeoutError') return 'timeout';
    if (e.name === 'AbortError') return 'cancelled';
    return e.name && e.name !== 'Error' ? e.name : '_OTHER';
  }
  return '_OTHER';
};

const exceptionAttrs = (e: unknown): Attributes =>
  e instanceof Error
    ? {
        'exception.type': e.name,
        'exception.message': e.message,
        ...(e.stack ? { 'exception.stacktrace': e.stack } : {}),
      }
    : e === undefined
      ? {}
      : { 'exception.message': String(e) };

const failSpan = (span: Span, e: unknown, type: string) => {
  span.setAttribute('error.type', type);
  if (e instanceof Error) span.recordException(e);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: e instanceof Error ? e.message : String(e),
  });
};

/** runs `fn` with `span` active, so auto-instrumented calls nest under it */
const within = <T>(
  span: Span,
  fn: () => T,
  parent: Context = context.active(),
) => context.with(trace.setSpan(parent, span), fn);

/** an internal phase span around `fn`; failures mark it and rethrow */
export const withSpan = async <T>(
  name: string,
  fn: () => Promise<T>,
  attributes: Attributes = {},
): Promise<T> => {
  const span = tracer().startSpan(name, {
    kind: SpanKind.INTERNAL,
    attributes,
  });
  try {
    return await within(span, fn);
  } catch (e) {
    failSpan(span, e, errorType(e));
    throw e;
  } finally {
    span.end();
  }
};

/** runs `fn` outside any trace; db/redis calls in it aren't recorded (requireParentSpan) */
export const untraced = <T>(fn: () => T): T => context.with(ROOT_CONTEXT, fn);

/* ---------- completions ---------- */

export type CompletionUsage = {
  promptTokens?: number | undefined;
  completionTokens?: number | undefined;
  cachedTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  costUsd?: number | undefined;
};

export type CompletionEnd = {
  usage?: CompletionUsage | undefined;
  responseModel?: string | undefined;
  responseId?: string | undefined;
  finishReasons?: string[] | undefined;
  /* assistant output, recorded only with content capture on */
  output?:
    | {
        text: string;
        reasoning?: string | undefined;
        calls?: WireCall[] | undefined;
      }
    | undefined;
};

export type CompletionFailure = {
  /* low-cardinality error.type; defaults to one derived from the exception */
  type?: string | undefined;
  cancelled?: boolean | undefined;
  /* upstream http status, when the provider answered with one */
  status?: number | undefined;
  /* the provider's error body, already shortened */
  responseBody?: string | undefined;
};

export type CompletionSpan = {
  /** runs fn with this span active (wrap the fetch so its http span nests here) */
  within: <T>(fn: () => T) => T;
  /** call on every streamed chunk: the first sets time-to-first-chunk, the rest time-per-chunk */
  chunk: () => void;
  end: (r: CompletionEnd) => void;
  /** no-op once the span has ended, so it is safe in a `finally` */
  fail: (e: unknown, opts?: CompletionFailure) => void;
};

/**
 * one completion round-trip. `operation` is `chat` for chat completions; other
 * endpoints (decisions, System One) pass their own name.
 */
export const startCompletion = (opts: {
  conn: ProviderConnectionRow;
  model: string;
  operation?: string;
  stream: boolean;
  step?: number | undefined;
  reasoningEffort?: string | undefined;
  tools?: readonly { function: { name: string } }[] | undefined;
  input?: readonly WireTurn[] | undefined;
  json?: boolean | undefined;
}): CompletionSpan => {
  const operation = opts.operation ?? 'chat';
  const capture = contentCapture();
  const attrs: Attributes = {
    'gen_ai.operation.name': operation,
    'gen_ai.request.model': opts.model,
    'gen_ai.request.stream': opts.stream,
    'gen_ai.output.type': opts.json ? 'json' : 'text',
    ...providerAttrs(opts.conn),
    ...(opts.step !== undefined ? { 'talkative.step': opts.step } : {}),
    ...(opts.reasoningEffort
      ? { 'talkative.request.reasoning_effort': opts.reasoningEffort }
      : {}),
    ...(opts.tools !== undefined
      ? { 'talkative.request.tools': opts.tools.map((t) => t.function.name) }
      : {}),
  };
  const span = tracer().startSpan(`${operation} ${opts.model}`, {
    kind: SpanKind.CLIENT,
    attributes: attrs,
  });
  const input =
    opts.input && capturing(capture)
      ? JSON.stringify(toMessages(opts.input))
      : undefined;
  if (input && capture.span) {
    span.setAttribute('gen_ai.input.messages', input);
    if (opts.tools?.length)
      span.setAttribute('gen_ai.tool.definitions', JSON.stringify(opts.tools));
  }
  const parent = context.active();
  const spanCtx = trace.setSpan(parent, span);
  const t0 = performance.now();
  let last: number | undefined;
  let ended = false;
  const finish = (extra: Attributes) => {
    ended = true;
    const metricAttrs = pick({ ...attrs, ...extra });
    meters().duration.record((performance.now() - t0) / 1000, metricAttrs);
    span.end();
    return metricAttrs;
  };
  return {
    within: (fn) => context.with(spanCtx, fn),
    chunk: () => {
      if (ended) return;
      const now = performance.now();
      if (last === undefined) {
        const s = (now - t0) / 1000;
        span.setAttribute('gen_ai.response.time_to_first_chunk', s);
        meters().firstChunk.record(s, pick(attrs));
      } else meters().perChunk.record((now - last) / 1000, pick(attrs));
      last = now;
    },
    end: (r) => {
      if (ended) return;
      const extra: Attributes = {
        ...(r.responseModel
          ? { 'gen_ai.response.model': r.responseModel }
          : {}),
        ...(r.responseId ? { 'gen_ai.response.id': r.responseId } : {}),
        ...(r.finishReasons?.length
          ? { 'gen_ai.response.finish_reasons': r.finishReasons }
          : {}),
      };
      const u = r.usage;
      if (u) {
        if (u.promptTokens !== undefined)
          extra['gen_ai.usage.input_tokens'] = u.promptTokens;
        if (u.completionTokens !== undefined)
          extra['gen_ai.usage.output_tokens'] = u.completionTokens;
        if (u.cachedTokens !== undefined)
          extra['gen_ai.usage.cache_read.input_tokens'] = u.cachedTokens;
        if (u.cacheWriteTokens !== undefined)
          extra['gen_ai.usage.cache_creation.input_tokens'] =
            u.cacheWriteTokens;
        if (u.reasoningTokens !== undefined)
          extra['gen_ai.usage.reasoning.output_tokens'] = u.reasoningTokens;
        if (u.costUsd !== undefined)
          extra['talkative.usage.cost_usd'] = u.costUsd;
      }
      span.setAttributes(extra);
      if (r.output && capturing(capture)) {
        const parts = [
          ...(r.output.reasoning
            ? [{ type: 'reasoning', content: clip(r.output.reasoning) }]
            : []),
          ...(toMessages([
            {
              role: 'assistant',
              content: r.output.text,
              tool_calls: r.output.calls,
            },
          ])[0]?.parts ?? []),
        ];
        const output = JSON.stringify([
          {
            role: 'assistant',
            parts,
            ...(r.finishReasons?.[0]
              ? { finish_reason: r.finishReasons[0] }
              : {}),
          },
        ]);
        if (capture.span) span.setAttribute('gen_ai.output.messages', output);
        if (capture.event)
          emitLog('info', 'gen_ai.client.inference.operation.details', {
            event: 'gen_ai.client.inference.operation.details',
            ctx: spanCtx,
            print: false,
            attributes: {
              ...attrs,
              ...extra,
              ...(input ? { 'gen_ai.input.messages': input } : {}),
              'gen_ai.output.messages': output,
            },
          });
      }
      const metricAttrs = finish(extra);
      const m = meters();
      if (u?.promptTokens !== undefined)
        m.tokens.record(u.promptTokens, {
          ...metricAttrs,
          'gen_ai.token.type': 'input',
        });
      if (u?.completionTokens !== undefined)
        m.tokens.record(u.completionTokens, {
          ...metricAttrs,
          'gen_ai.token.type': 'output',
        });
    },
    fail: (e, o = {}) => {
      if (ended) return;
      if (o.cancelled) {
        span.setAttribute('talkative.cancelled', true);
        finish({});
        return;
      }
      const type =
        o.type ?? (o.status !== undefined ? String(o.status) : errorType(e));
      failSpan(span, e, type);
      if (e instanceof Error)
        (e as Error & { [ERROR_TYPE]?: string })[ERROR_TYPE] = type;
      if (o.status !== undefined)
        span.setAttribute('http.response.status_code', o.status);
      emitLog('error', `${operation} ${opts.model} failed`, {
        event: 'gen_ai.client.operation.exception',
        ctx: spanCtx,
        attributes: {
          ...pick(attrs),
          'talkative.provider.connection_name': opts.conn.name,
          'error.type': type,
          ...(o.status !== undefined
            ? { 'http.response.status_code': o.status }
            : {}),
          ...(o.responseBody
            ? { 'talkative.response.body': o.responseBody }
            : {}),
          ...exceptionAttrs(e),
        },
      });
      finish({ 'error.type': type });
    },
  };
};

/* ---------- agent runs ---------- */

export type RunStatus = 'done' | 'stopped' | 'error' | 'interrupted';

export type AgentSpan = {
  span: Span;
  /** the context to run the reply in; completions and tools nest under it */
  ctx: Context;
  /** folds one completion's usage into the reply's totals */
  addUsage: (u: CompletionUsage | undefined) => void;
  setAttributes: (a: Attributes) => void;
  end: (r: {
    status: RunStatus;
    error?: unknown;
    steps: number;
    toolCalls: number;
  }) => void;
};

/**
 * a whole reply: a new trace root (the run outlives the request that started it),
 * linked to the active request span when there is one
 */
export const startAgentRun = (opts: {
  chatId: string;
  messageId: string;
  userId: string;
  modelId: string;
  transient: boolean;
  resumed: boolean;
  tools: readonly string[];
  thinkingLevel?: string | undefined;
}): AgentSpan => {
  const requestCtx = trace.getSpanContext(context.active());
  const links: Link[] = requestCtx
    ? [{ context: requestCtx, attributes: { 'talkative.link': 'request' } }]
    : [];
  const attrs: Attributes = {
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.agent.name': SCOPE,
    'gen_ai.conversation.id': opts.chatId,
    'talkative.model.id': opts.modelId,
    'talkative.message.id': opts.messageId,
    'user.id': opts.userId,
    'talkative.run.transient': opts.transient,
    'talkative.run.resumed': opts.resumed,
    'talkative.tools.available': [...opts.tools],
    ...(opts.thinkingLevel
      ? { 'talkative.thinking_level': opts.thinkingLevel }
      : {}),
  };
  const span = tracer().startSpan(
    `invoke_agent ${SCOPE}`,
    { kind: SpanKind.INTERNAL, root: true, links, attributes: attrs },
    ROOT_CONTEXT,
  );
  const ctx = trace.setSpan(ROOT_CONTEXT, span);
  const t0 = performance.now();
  const totals = {
    input: 0,
    output: 0,
    cached: 0,
    reasoning: 0,
    cost: 0,
    seen: false,
  };
  let ended = false;
  meters().active.add(1);
  return {
    span,
    ctx,
    addUsage: (u) => {
      if (!u) return;
      totals.seen = true;
      totals.input += u.promptTokens ?? 0;
      totals.output += u.completionTokens ?? 0;
      totals.cached += u.cachedTokens ?? 0;
      totals.reasoning += u.reasoningTokens ?? 0;
      totals.cost += u.costUsd ?? 0;
    },
    setAttributes: (a) => {
      span.setAttributes(a);
      Object.assign(attrs, a);
    },
    end: (r) => {
      if (ended) return;
      ended = true;
      const seconds = (performance.now() - t0) / 1000;
      const usage: Attributes = totals.seen
        ? {
            'gen_ai.usage.input_tokens': totals.input,
            'gen_ai.usage.output_tokens': totals.output,
            ...(totals.cached > 0
              ? { 'gen_ai.usage.cache_read.input_tokens': totals.cached }
              : {}),
            ...(totals.reasoning > 0
              ? { 'gen_ai.usage.reasoning.output_tokens': totals.reasoning }
              : {}),
            ...(totals.cost > 0
              ? { 'talkative.usage.cost_usd': totals.cost }
              : {}),
          }
        : {};
      const summary: Attributes = {
        'talkative.run.status': r.status,
        'talkative.run.steps': r.steps,
        'talkative.run.tool_calls': r.toolCalls,
        ...usage,
      };
      span.setAttributes(summary);
      const extra: Attributes = {};
      if (r.status === 'stopped')
        span.setAttribute('talkative.cancelled', true);
      if (r.status === 'error') {
        const type = errorType(r.error);
        extra['error.type'] = type;
        failSpan(span, r.error ?? 'error', type);
      }
      const m = meters();
      m.active.add(-1);
      m.runs.add(1, {
        ...pick({ ...attrs, ...extra }),
        'talkative.run.status': r.status,
      });
      m.duration.record(seconds, pick({ ...attrs, ...extra }));
      emitLog(r.status === 'error' ? 'error' : 'info', `reply ${r.status}`, {
        event: 'talkative.agent.run',
        ctx,
        attributes: {
          ...pick({ ...attrs, ...extra }),
          'gen_ai.conversation.id': opts.chatId,
          'talkative.message.id': opts.messageId,
          'talkative.duration_s': Math.round(seconds * 1000) / 1000,
          ...summary,
          ...(r.status === 'error' ? exceptionAttrs(r.error) : {}),
        },
      });
      span.end();
    },
  };
};

/* ---------- tools ---------- */

/**
 * one tool call, as a child of the active (reply) span. `fn` runs with the tool
 * span active so the tool's own fetches nest under it; it must not throw —
 * invokeTool reports failures as `{ ok: false }`.
 */
export const traceTool = async <
  R extends { ok: boolean; result: string; ms: number },
>(
  opts: {
    name: string;
    callId: string;
    args: string;
    description?: string | undefined;
    provider?: string | undefined;
  },
  fn: () => Promise<R>,
): Promise<R> => {
  const attrs: Attributes = {
    'gen_ai.operation.name': 'execute_tool',
    'gen_ai.tool.name': opts.name,
    'gen_ai.tool.call.id': opts.callId,
    'gen_ai.tool.type': 'function',
    ...(opts.description
      ? { 'gen_ai.tool.description': opts.description }
      : {}),
    ...(opts.provider ? { 'talkative.tool.provider': opts.provider } : {}),
  };
  const span = tracer().startSpan(`execute_tool ${opts.name}`, {
    kind: SpanKind.INTERNAL,
    attributes: attrs,
  });
  const capture = contentCapture().span;
  if (capture) span.setAttribute('gen_ai.tool.call.arguments', clip(opts.args));
  const r = await within(span, fn);
  if (capture) span.setAttribute('gen_ai.tool.call.result', clip(r.result));
  const metricAttrs: Attributes = {
    'gen_ai.tool.name': opts.name,
    ...(opts.provider ? { 'talkative.tool.provider': opts.provider } : {}),
  };
  if (!r.ok) {
    /* the result text is "error: <message>"; it's the tool's error, not user content */
    const message = r.result.replace(/^error:\s*/, '').slice(0, 500);
    span.setAttribute('error.type', 'tool_error');
    span.setStatus({ code: SpanStatusCode.ERROR, message });
    metricAttrs['error.type'] = 'tool_error';
    emitLog('warn', `tool ${opts.name} failed`, {
      event: 'talkative.tool.error',
      ctx: trace.setSpan(context.active(), span),
      attributes: {
        ...metricAttrs,
        'gen_ai.tool.call.id': opts.callId,
        'exception.message': message,
      },
    });
  }
  meters().tool.record(r.ms / 1000, metricAttrs);
  span.end();
  return r;
};

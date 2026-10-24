/*
 * Runs — the in-process registry and agent loop behind every streamed
 * assistant reply.
 *
 * Business logic:
 * - generations run detached from the http request that started them,
 *   so a closed tab or refresh only drops a subscriber; live text
 *   sits in this process and the message row is flushed every second
 *   (FLUSH_MS), so a crash loses at most that much. single-instance
 *   only: a second server process won't see these runs.
 * - the registry hangs off globalThis so dev-server HMR doesn't
 *   orphan in-flight runs; lookups are user-scoped — someone else's
 *   run reads as missing — and finished runs linger 60 s (KEEP_MS) so
 *   a reconnecting subscriber is served from memory before the
 *   stream route falls back to the db row.
 * - stopRun aborts the run's AbortController and a user stop
 *   finalizes as `stopped`, not an error; calls still running at
 *   that point settle to error results so the stored message stays
 *   replayable. settleOrphan marks rows left `streaming` by a dead
 *   server process `interrupted`.
 * - the agent loop streams a completion; if it ends in tool calls it
 *   runs them in parallel and appends the results in call order
 *   (which some providers require), then goes again until the model
 *   answers without calling anything — at most 8 round-trips
 *   (MAX_STEPS), and the last one is offered no tools so it has to
 *   answer.
 * - ask_user must be the only tool call in a turn; mixed with others
 *   it is rejected with an error result instead of running.
 * - a retry resumes mid-reply: resumeAt cuts the message back to the
 *   step holding the failed call, reruns only failed calls (results
 *   that succeeded are kept, not re-executed) and replays the
 *   earlier steps as provider turns.
 * - messageTurns replays a stored assistant message per tool step:
 *   an assistant turn carrying the text written before the step plus
 *   its calls, then the results; calls with no result are dropped
 *   because providers reject unanswered tool calls. historyTurns
 *   also drops empty and errored replies, which would only confuse
 *   the model.
 * - a user turn's attachments are inlined ahead of its text — notes
 *   as <note>, files as <attachment> with their extracted text, urls
 *   passed through as the link to fetch; images travel as openai
 *   image_url content parts instead, and a turn with no text at all
 *   still gets an empty text part so it isn't dropped.
 * - the stream parser absorbs provider quirks: multi-line `data:`
 *   frames (bifrost pretty-prints json), reasoning under `reasoning`
 *   or `reasoning_content`, tool-call fragments keyed by index,
 *   usage on the last chunk, refusals, url citations on the complete
 *   message, and routing extras (bifrost extra_fields, openrouter's
 *   opt-in metadata header).
 * - an upstream quiet for 2 min (IDLE_MS) aborts the fetch and
 *   surfaces as "<provider> stopped responding", distinct from a
 *   user stop; a reasoning block is closed with its elapsed time by
 *   any other event or by the end of the run.
 * - finalize persists the row (text, calls, thoughts, refusal,
 *   citations, usage, routing, status) before `done` is emitted, so
 *   a reload right after sees the final state; the chat's costUsd
 *   only ever grows by provider-reported cost (bifrost), never an
 *   estimate from token rates.
 * - demo catalog models (ids without the `${connectionId}:${remoteId}`
 *   shape) have no backend: mockReply streams a canned placeholder
 *   so the composer stays usable before any provider is configured.
 */
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { getDb } from '../db';
import type { ProviderConnectionRow } from '../db/schema';
import { chats, type MessageRow, messages } from '../db/schema';
import type {
  Attachment,
  MessageRouting,
  MessageStatus,
  MessageUsage,
  MessageUsageDetails,
  ThinkingLevel,
  Thought,
  ToolCall,
  UrlCitation,
} from '../types';
import { OPENROUTER_ATTRIBUTION, USER_AGENT } from './identity';
import { parseModelId } from './model-id';
import { findConnection } from './providers';
import { decryptSecret } from './secrets';
import { type ActiveTool, invokeTool, toolSpec } from './tools';

const FLUSH_MS = 1000;
/* finished runs linger briefly so late subscribers are served from memory */
const KEEP_MS = 60_000;
/* an upstream that goes quiet this long is treated as dead */
const IDLE_MS = 120_000;
/* model round-trips per reply; the last one is offered no tools so it has to answer */
const MAX_STEPS = 8;

export type FinalStatus = Exclude<MessageStatus, 'streaming'>;
export type RunFinal = { status: FinalStatus; error?: string | undefined };
export type RunEvent =
  | { type: 'delta'; text: string }
  /* sent when a call starts and again when it settles; clients upsert by id */
  | { type: 'tool'; call: ToolCall }
  /* reasoning text for step's block; `at` lets a client create the block on first sight */
  | { type: 'thought-delta'; step: number; at: number; text: string }
  /* the whole block, sent when it closes; clients replace by step */
  | { type: 'thought'; thought: Thought }
  | ({
      type: 'done';
    } & RunFinal & {
        usage?: MessageUsage | undefined;
        usageDetails?: MessageUsageDetails | undefined;
        routing?: MessageRouting | undefined;
        refusal?: string | undefined;
        annotations?: UrlCitation[] | undefined;
      });

type Run = {
  messageId: string;
  chatId: string;
  /* whose chat this is; tools and provider lookups act as this user */
  userId: string;
  /* transient runs have no message/chat rows in the db */
  transient?: boolean | undefined;
  text: string;
  toolCalls: ToolCall[];
  thoughts: Thought[];
  /* the model declined; holds the refusal text */
  refusal?: string;
  /* web-search citations collected across steps */
  annotations: UrlCitation[];
  final: RunFinal | null;
  usage?: MessageUsage;
  usageDetails?: MessageUsageDetails;
  routing?: MessageRouting;
  listeners: Set<(e: RunEvent) => void>;
  abort: AbortController;
};

type WireCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

/* openai multimodal content part for user turns */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/* openai chat-completions message shapes */
export type Turn =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: WireCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

const toWire = (c: Pick<ToolCall, 'id' | 'name' | 'args'>): WireCall => ({
  id: c.id,
  type: 'function',
  function: { name: c.name, arguments: c.args || '{}' },
});

/* epoch ms → "[yyyy/mm/dd HH:mm]" in the server's local time */
export const localStamp = (ts: number): string => {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `[${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}]`;
};

/* prepends a "[yyyy/mm/dd HH:mm]" stamp to a turn's text content */
export const prefixTurn = <T extends Turn>(
  t: T,
  stamp: string | undefined,
): T => {
  if (!stamp || t.role === 'tool') return t;
  if (typeof t.content === 'string')
    return { ...t, content: `${stamp} ${t.content}` } as T;
  if (Array.isArray(t.content)) {
    const first = t.content.findIndex((p) => p.type === 'text');
    const content: ContentPart[] =
      first === -1
        ? [{ type: 'text', text: stamp }, ...t.content]
        : t.content.map((p, i) =>
            i === first && p.type === 'text'
              ? { ...p, text: `${stamp} ${p.text}` }
              : p,
          );
    return { ...t, content } as T;
  }
  return t;
};

/**
 * replays a stored message as provider turns: each tool step becomes an assistant
 * turn carrying the text written before it plus its calls, followed by the results
 */
export const messageTurns = (
  m: Pick<MessageRow, 'role' | 'toolCalls'> & {
    content: string | ContentPart[];
  },
): Turn[] => {
  if (m.role === 'user') return [{ role: 'user', content: m.content }];
  /* a call with no result can't be replayed; providers reject unanswered calls */
  const calls = (m.toolCalls as ToolCall[]).filter(
    (c) => c.status !== 'running',
  );
  const out: Turn[] = [];
  let pos = 0;
  for (const step of new Set(calls.map((c) => c.step))) {
    const group = calls.filter((c) => c.step === step);
    const at = Math.min(Math.max(pos, group[0]?.at ?? pos), m.content.length);
    out.push({
      role: 'assistant',
      content: (m.content as string).slice(pos, at) || null,
      tool_calls: group.map(toWire),
    });
    for (const c of group)
      out.push({ role: 'tool', tool_call_id: c.id, content: c.result ?? '' });
    pos = at;
  }
  const tail = (m.content as string).slice(pos);
  if (tail) out.push({ role: 'assistant', content: tail });
  return out;
};

/* note bodies by id, used to inline note attachments into user turns */
export type NoteTexts = ReadonlyMap<string, { title: string; text: string }>;
/* memory facts by id, used to inline memory attachments into user turns */
export type MemoryTexts = ReadonlyMap<string, { key: string; value: string }>;
/* other chats by id, inlined as a transcript of their visible branch */
export type ChatTexts = ReadonlyMap<
  string,
  { title: string; turns: { role: 'user' | 'assistant'; content: string }[] }
>;

/* the resolved bodies behind note/memory/chat attachments on a path of turns */
export type Refs = {
  notes: NoteTexts;
  memories: MemoryTexts;
  chats: ChatTexts;
};

export const emptyRefs = (): Refs => ({
  notes: new Map(),
  memories: new Map(),
  chats: new Map(),
});

/* a stored/served attachment plus its extracted text, used to inline it ahead of the turn */
export type InlineAttachment = Attachment & {
  text?: string | undefined;
  dataUrl?: string | undefined;
};

const isTextMime = (mime: string | undefined): boolean =>
  !!mime &&
  (mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml');

/* a url attachment has no stored text, so hand the model the url to fetch */
const urlBody = (a: { url?: string | undefined }): string =>
  a.url ? `URL: ${a.url}` : '(no url)';

/* a user turn's text with its attached notes, memories, chats and files inlined ahead of it */
export const userContent = (
  m: Pick<MessageRow, 'content' | 'attachments'>,
  refs: Refs,
): string => {
  const blocks = (m.attachments as InlineAttachment[]).flatMap((a) => {
    if (a.kind === 'note') {
      const n = a.noteId ? refs.notes.get(a.noteId) : undefined;
      return n
        ? [`<note title=${JSON.stringify(n.title)}>\n${n.text}\n</note>`]
        : [];
    }
    if (a.kind === 'memory') {
      const mem = a.memoryId ? refs.memories.get(a.memoryId) : undefined;
      return mem
        ? [`<memory key=${JSON.stringify(mem.key)}>\n${mem.value}\n</memory>`]
        : [];
    }
    if (a.kind === 'chat') {
      const c = a.chatId ? refs.chats.get(a.chatId) : undefined;
      if (!c) return [];
      const body = c.turns
        .map((t) => `<role=${t.role}>\n${t.content}\n</role>`)
        .join('\n');
      return [`<chat title=${JSON.stringify(c.title)}>\n${body}\n</chat>`];
    }
    if (a.kind === 'url')
      return [
        `<attachment name=${JSON.stringify(a.name)}>\n${urlBody(a)}\n</attachment>`,
      ];
    if (a.kind === 'file' && a.text !== undefined)
      return [
        `<attachment name=${JSON.stringify(a.name)} mime=${JSON.stringify(a.mime ?? '')}>\n${a.text}\n</attachment>`,
      ];
    return [];
  });
  return [...blocks, m.content].filter((s) => s !== '').join('\n\n');
};

/* a user turn as openai content parts: inlined text/notes/memories/chats/urls plus images */
export const userParts = (
  m: Pick<MessageRow, 'content' | 'attachments'>,
  refs: Refs,
): ContentPart[] => {
  const parts: ContentPart[] = [];
  const text = userContent(m, refs);
  if (text !== '') parts.push({ type: 'text', text });
  for (const a of m.attachments as InlineAttachment[]) {
    if (a.dataUrl)
      parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
  }
  /* no content parts at all → send an empty text part so the turn isn't dropped */
  if (parts.length === 0) parts.push({ type: 'text', text: '' });
  return parts;
};

/* earlier turns that produced text; failed or empty replies would only confuse the model */
export const historyTurns = (
  path: Pick<
    MessageRow,
    'role' | 'content' | 'attachments' | 'toolCalls' | 'status' | 'createdAt'
  >[],
  refs: Refs = emptyRefs(),
  opts: { timestamps?: boolean | undefined } = {},
): Turn[] =>
  path
    .map((m) => {
      if (m.role !== 'user') return m;
      const atts = (m.attachments as InlineAttachment[]) ?? [];
      /* images travel as content parts; text-only turns stay strings, which is what
         every provider's replay path already handles */
      const hasImage = atts.some((a) => a.dataUrl !== undefined);
      return {
        ...m,
        content: hasImage ? userParts(m, refs) : userContent(m, refs),
      };
    })
    .filter(
      (m) => m.content !== '' && (m.role === 'user' || m.status !== 'error'),
    )
    .flatMap((m) => {
      const turns = messageTurns(m);
      if (!opts.timestamps) return turns;
      /* stamp the message's first textual turn; tool-result turns stay untouched */
      const stamp = localStamp(m.createdAt.getTime());
      const first = turns.findIndex(
        (t) => t.role === 'user' || (t.role === 'assistant' && t.content),
      );
      if (first === -1) return turns;
      return turns.map((t, i) => (i === first ? prefixTurn(t, stamp) : t));
    });

/** where a retried reply picks up: the step to redo, with the reply as it stood before it */
export type Resume = {
  step: number;
  /* the step's calls in their original order; failed ones run again */
  calls: ToolCall[];
  /* what the model wrote between the previous step and this one's calls */
  stepText: string;
  /* the run's starting state */
  text: string;
  toolCalls: ToolCall[];
  thoughts: Thought[];
};

/**
 * cuts reply `m` back to the tool step holding `callId`, for a retry that reruns that
 * step's failed calls and continues from there. `turns` replays the earlier steps.
 * null when the call isn't one that failed.
 */
export const resumeAt = (
  m: Pick<MessageRow, 'content' | 'toolCalls' | 'thoughts'>,
  callId: string,
): { resume: Resume; turns: Turn[] } | null => {
  const toolCalls = m.toolCalls as ToolCall[];
  const thoughts = m.thoughts as Thought[];
  const failed = toolCalls.find((c) => c.id === callId);
  if (failed?.status !== 'error') return null;
  const { step } = failed;
  const before = toolCalls.filter((c) => c.step < step);
  const calls = toolCalls
    .filter((c) => c.step === step)
    .map(
      (c): ToolCall =>
        c.status === 'error'
          ? {
              id: c.id,
              name: c.name,
              args: c.args,
              status: 'running',
              at: c.at,
              step,
            }
          : c,
    );
  const at = Math.min(calls[0]?.at ?? 0, m.content.length);
  /* the text since the previous step belongs to this step's assistant turn, not the replay */
  const base = Math.min(before.at(-1)?.at ?? 0, at);
  return {
    resume: {
      step,
      calls,
      stepText: m.content.slice(base, at),
      text: m.content.slice(0, at),
      toolCalls: [...before, ...calls],
      thoughts: thoughts.filter((t) => t.step <= step),
    },
    turns: messageTurns({
      role: 'assistant',
      content: m.content.slice(0, base),
      toolCalls: before,
    }),
  };
};

/* calls cut off by a stop or crash still need a result to be replayable */
const settleCalls = (calls: ToolCall[], why: string): ToolCall[] =>
  calls.map((c) =>
    c.status === 'running'
      ? { ...c, status: 'error', result: `error: ${why}` }
      : c,
  );

/* cached on globalThis so dev-server HMR doesn't orphan in-flight runs */
const g = globalThis as typeof globalThis & { __runs?: Map<string, Run> };
g.__runs ??= new Map<string, Run>();
const runs = g.__runs;

/* someone else's run reads as missing */
export const getRun = (messageId: string, userId: string) => {
  const run = runs.get(messageId);
  return run?.userId === userId ? run : undefined;
};

export const hasActiveRun = (chatId: string) =>
  [...runs.values()].some((r) => r.chatId === chatId && !r.final);

export const stopRun = (messageId: string, userId?: string): boolean => {
  const run = runs.get(messageId);
  if (userId !== undefined && run?.userId !== userId) return false;
  if (!run || run.final) return false;
  run.abort.abort();
  return true;
};

export const stopChatRuns = (chatId: string) => {
  for (const r of runs.values()) if (r.chatId === chatId) stopRun(r.messageId);
};

/** registers a listener; returns the unsubscribe */
export const subscribe = (run: Run, fn: (e: RunEvent) => void) => {
  run.listeners.add(fn);
  return () => {
    run.listeners.delete(fn);
  };
};

/**
 * a row still marked streaming with no live run belongs to a previous server
 * process, so nothing will ever finish it
 */
export const settleOrphan = async (db: Db, m: MessageRow) => {
  if (m.status !== 'streaming' || runs.has(m.id)) return;
  await db
    .update(messages)
    .set({
      status: 'interrupted',
      toolCalls: settleCalls(m.toolCalls as ToolCall[], 'interrupted'),
    })
    .where(eq(messages.id, m.id));
};

export const startRun = (opts: {
  messageId: string;
  chatId: string;
  userId: string;
  modelId: string;
  thinkingLevel?: ThinkingLevel | undefined;
  history: Turn[];
  tools: ActiveTool[];
  /* set for a retry: the run starts mid-reply, at the step being redone */
  resume?: Resume | undefined;
  /* transient runs are never persisted: no message/chat rows exist, so flush and finalize skip the db */
  transient?: boolean | undefined;
}) => {
  const run: Run = {
    messageId: opts.messageId,
    chatId: opts.chatId,
    userId: opts.userId,
    text: opts.resume?.text ?? '',
    toolCalls: opts.resume?.toolCalls ?? [],
    thoughts: opts.resume?.thoughts ?? [],
    annotations: [],
    final: null,
    listeners: new Set(),
    abort: new AbortController(),
    transient: opts.transient === true,
  };
  runs.set(run.messageId, run);
  void execute(
    run,
    opts.modelId,
    opts.thinkingLevel,
    opts.history,
    opts.tools,
    opts.resume,
  );
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function execute(
  run: Run,
  modelId: string,
  thinkingLevel: ThinkingLevel | undefined,
  history: Turn[],
  tools: ActiveTool[],
  resume: Resume | undefined,
) {
  let flushed = 0;
  /* bumped on every tool or thought change; both lists are flushed whole when it moves */
  let rev = 0;
  let revFlushed = 0;
  /* cast keeps the union — ts can't see the assignment inside flush() */
  let flushing = null as Promise<void> | null;
  const flush = () => {
    if (flushing || (run.text.length === flushed && rev === revFlushed)) return;
    const text = run.text;
    const at = rev;
    const { toolCalls, thoughts } = run;
    /* transient runs have no row to flush; still advance the cursor so finalize stays in sync */
    if (run.transient) {
      flushed = text.length;
      revFlushed = at;
      return;
    }
    flushing = getDb()
      .update(messages)
      .set({ content: text, toolCalls, thoughts })
      .where(eq(messages.id, run.messageId))
      .then(() => {
        flushed = text.length;
        revFlushed = at;
      })
      .catch((e: unknown) =>
        console.warn(`[runs] flush failed: ${errorText(e)}`),
      )
      .finally(() => {
        flushing = null;
      });
  };
  const timer = setInterval(flush, FLUSH_MS);

  /* measure total generation latency */
  const startedAt = Date.now();

  /* the block still receiving reasoning; any other event means the model moved on */
  let thinking: { step: number; since: number } | null = null;
  const closeThought = () => {
    if (!thinking) return;
    const { step, since } = thinking;
    thinking = null;
    const ms = Date.now() - since;
    run.thoughts = run.thoughts.map((t) =>
      t.step === step ? { ...t, ms } : t,
    );
    rev++;
    const thought = run.thoughts.find((t) => t.step === step);
    if (thought) for (const l of run.listeners) l({ type: 'thought', thought });
  };

  let final: RunFinal;
  try {
    for await (const ev of generate(
      run,
      modelId,
      thinkingLevel,
      history,
      tools,
      resume,
      run.abort.signal,
    )) {
      if (ev.type === 'reasoning') {
        const prev = run.thoughts.find((t) => t.step === ev.step);
        const at = prev?.at ?? run.text.length;
        run.thoughts = prev
          ? run.thoughts.map((t) =>
              t === prev ? { ...t, text: t.text + ev.text } : t,
            )
          : [...run.thoughts, { step: ev.step, at, text: ev.text }];
        thinking ??= { step: ev.step, since: Date.now() };
        rev++;
        for (const l of run.listeners)
          l({ type: 'thought-delta', step: ev.step, at, text: ev.text });
        continue;
      }
      closeThought();
      if (ev.type === 'text') {
        run.text += ev.text;
        for (const l of run.listeners) l({ type: 'delta', text: ev.text });
        continue;
      }
      const prev = run.toolCalls.find((c) => c.id === ev.call.id);
      const call: ToolCall = { ...ev.call, at: prev?.at ?? run.text.length };
      run.toolCalls = prev
        ? run.toolCalls.map((c) => (c === prev ? call : c))
        : [...run.toolCalls, call];
      rev++;
      for (const l of run.listeners) l({ type: 'tool', call });
    }
    final = { status: 'done' };
  } catch (e) {
    final = run.abort.signal.aborted
      ? { status: 'stopped' }
      : { status: 'error', error: errorText(e) };
  } finally {
    clearInterval(timer);
  }
  closeThought();
  await flushing;
  const settled = settleCalls(run.toolCalls, final.status);
  /* settleCalls keeps unchanged calls by identity, so this only reports the cut-off ones */
  settled.forEach((call, i) => {
    if (call !== run.toolCalls[i])
      for (const l of run.listeners) l({ type: 'tool', call });
  });
  run.toolCalls = settled;

  if (!run.transient) {
    try {
      const db = getDb();
      await db
        .update(messages)
        .set({
          content: run.text,
          toolCalls: run.toolCalls,
          thoughts: run.thoughts,
          refusal: run.refusal ?? null,
          annotations: run.annotations,
          status: final.status,
          error: final.error ?? null,
          usage: run.usage ?? null,
          usageDetails: run.usageDetails ?? null,
          routing: run.routing ?? null,
          latencyMs: run.usage ? Date.now() - startedAt : null,
        })
        .where(eq(messages.id, run.messageId));
      /* add this reply's spend to the chat total: only the exact provider-reported cost (bifrost); never estimated from token rates */
      const cost = run.usage?.costUsd ?? 0;
      await db
        .update(chats)
        .set({
          updatedAt: new Date(),
          ...(cost > 0
            ? { costUsd: sql`${chats.costUsd} + ${cost.toFixed(6)}` }
            : {}),
        })
        .where(eq(chats.id, run.chatId));
    } catch (e) {
      console.error(`[runs] finalize failed for ${run.messageId}`, e);
    }
  }

  /* the row is final before anyone hears 'done', so a reload right after sees it */
  run.final = final;
  for (const l of run.listeners)
    l({
      type: 'done',
      ...final,
      usage: run.usage,
      ...(run.usageDetails ? { usageDetails: run.usageDetails } : {}),
      ...(run.routing ? { routing: run.routing } : {}),
      ...(run.refusal ? { refusal: run.refusal } : {}),
      ...(run.annotations.length > 0 ? { annotations: run.annotations } : {}),
    });
  run.listeners.clear();
  setTimeout(() => runs.delete(run.messageId), KEEP_MS).unref?.();
}

/* ---------- generation ---------- */

type GenEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; step: number; text: string }
  /* `at` is filled in by the run, which knows how much text came before */
  | { type: 'tool'; call: Omit<ToolCall, 'at'> };

/**
 * the agent loop: stream a completion; if it ends in tool calls, run them, append the
 * results and go again, until the model answers without calling anything
 */
async function* generate(
  run: Run,
  modelId: string,
  thinkingLevel: ThinkingLevel | undefined,
  history: Turn[],
  tools: ActiveTool[],
  resume: Resume | undefined,
  signal: AbortSignal,
): AsyncGenerator<GenEvent> {
  const parsed = parseModelId(modelId);
  if (!parsed) {
    for await (const text of mockReply(modelId, signal))
      yield { type: 'text', text };
    return;
  }
  const conn = await findConnection(run.userId, parsed.connectionId);
  if (!conn) throw new Error('provider connection no longer exists');
  if (!conn.enabled) throw new Error(`provider "${conn.name}" is disabled`);
  const specs = tools.map(toolSpec);
  const turns = [...history];
  let first = 0;
  if (resume) {
    /* redo the interrupted step as if the model had just asked for it */
    const calls = resume.calls.map(toWire);
    turns.push({
      role: 'assistant',
      content: resume.stepText || null,
      tool_calls: calls,
    });
    const kept = new Map(
      resume.calls.flatMap((c) =>
        c.status === 'running' ? [] : [[c.id, c.result ?? ''] as const],
      ),
    );
    yield* runTools(run, calls, tools, resume.step, turns, signal, kept);
    first = resume.step + 1;
  }
  for (let step = first; ; step++) {
    const offer = step < MAX_STEPS - 1 ? specs : [];
    const { text, calls, usage, usageDetails, routing, refusal, annotations } =
      yield* chatCompletions(
        conn,
        parsed.remoteId,
        thinkingLevel,
        turns,
        offer,
        step,
        signal,
      );
    if (usage) run.usage = usage;
    if (usageDetails) run.usageDetails = usageDetails;
    if (routing) run.routing = routing;
    if (refusal) run.refusal = refusal;
    for (const a of annotations ?? [])
      if (!run.annotations.some((x) => x.url === a.url))
        run.annotations.push(a);
    if (calls.length === 0) return;
    turns.push({ role: 'assistant', content: text || null, tool_calls: calls });
    yield* runTools(run, calls, tools, step, turns, signal);
  }
}

/*
 * runs one step's calls in parallel, reporting each as it settles. `kept` holds results
 * already known (a retry's calls that succeeded the first time); those don't run again.
 */
async function* runTools(
  run: Run,
  calls: WireCall[],
  tools: ActiveTool[],
  step: number,
  turns: Turn[],
  signal: AbortSignal,
  kept: ReadonlyMap<string, string> = new Map(),
): AsyncGenerator<GenEvent> {
  const started = calls.map((c) => ({
    id: c.id,
    name: c.function.name,
    args: c.function.arguments,
    status: 'running' as const,
    step,
  }));
  /* ask_user must be the only tool call in a turn; if mixed with others, reject it */
  const hasAskUser = started.some((c) => c.name === 'ask_user');
  const rejectedIds = new Set<string>();
  if (hasAskUser && started.length > 1) {
    for (const c of started) {
      if (c.name === 'ask_user') {
        rejectedIds.add(c.id);
        yield {
          type: 'tool',
          call: {
            ...c,
            status: 'error',
            result: 'error: ask_user must be the only tool call in a turn',
            ms: 0,
          },
        };
      }
    }
  }
  const todo = started.filter((c) => !kept.has(c.id) && !rejectedIds.has(c.id));
  for (const call of todo) yield { type: 'tool', call };
  const pending = new Map(
    todo.map((c) => [
      c.id,
      invokeTool(c.name, c.args, tools, {
        signal,
        messageId: run.messageId,
        chatId: run.chatId,
        userId: run.userId,
        callId: c.id,
        calls: () => run.toolCalls,
      }).then((r) => ({ c, ...r })),
    ]),
  );
  const results = new Map(kept);
  for (const id of rejectedIds)
    results.set(id, 'error: ask_user must be the only tool call in a turn');
  while (pending.size > 0) {
    const r = await Promise.race(pending.values());
    pending.delete(r.c.id);
    results.set(r.c.id, r.result);
    yield {
      type: 'tool',
      call: {
        ...r.c,
        status: r.ok ? 'done' : 'error',
        result: r.result,
        ...(r.raw !== undefined ? { raw: r.raw } : {}),
        ms: r.ms,
      },
    };
  }
  /* a stop mid-tool ends the reply instead of feeding "aborted" back to the model */
  if (signal.aborted) throw signal.reason;
  /* results go back in call order, which some providers require */
  for (const c of started)
    turns.push({
      role: 'tool',
      tool_call_id: c.id,
      content: results.get(c.id) ?? '',
    });
}

/* every supported compatibility speaks openai chat completions with sse streaming */
const COMPLETIONS_PATH: Record<ProviderConnectionRow['compatibility'], string> =
  {
    openai: '/v1/chat/completions',
    openrouter: '/api/v1/chat/completions',
    lmstudio: '/v1/chat/completions',
    ollama: '/v1/chat/completions',
    bifrost: '/v1/chat/completions',
  };

type PartialCall = { id: string; name: string; args: string };

/*
 * extracts the `data:` value from one sse frame. a value can span several lines (bifrost
 * pretty-prints json), so continuation lines that aren't a new sse field are kept as-is.
 */
const sseData = (block: string): string => {
  const out: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('data:')) out.push(line.slice(5).replace(/^ /, ''));
    else if (out.length > 0 && !/^[a-zA-Z]*:/.test(line)) out.push(line);
  }
  return out.join('\n');
};

type ReportedCost = {
  total_cost?: number;
  input_tokens_cost?: number;
  output_tokens_cost?: number;
  reasoning_tokens_cost?: number;
  citation_tokens_cost?: number;
  search_queries_cost?: number;
  request_cost?: number;
};

/* a cost shape is defined by at least one non-null number member */
const nonEmptyCost = (
  c: MessageUsageDetails['cost'],
): c is NonNullable<MessageUsageDetails['cost']> => {
  if (!c) return false;
  return Object.values(c).some((v) => typeof v === 'number');
};

/* bifrost reports cost under usage.cost; prefer total_cost, else sum the breakdown */
const reportedCost = (cost: ReportedCost | undefined): number | undefined => {
  if (!cost) return undefined;
  if (typeof cost.total_cost === 'number') return cost.total_cost;
  const sum = [
    cost.input_tokens_cost,
    cost.output_tokens_cost,
    cost.reasoning_tokens_cost,
    cost.citation_tokens_cost,
    cost.search_queries_cost,
    cost.request_cost,
  ].reduce<number>((acc, p) => acc + (typeof p === 'number' ? p : 0), 0);
  return sum > 0 ? sum : undefined;
};

/**
 * Maps app ThinkingLevel to the provider's reasoning-effort request
 * parameter. Returns undefined when the model isn't reasoning
 * (level 'off'), otherwise the shape each compatibility expects:
 * - openai/openrouter/ollama/lmstudio: top-level `reasoning_effort`
 *   with values `none`/`low`/`medium`/`high`.
 * - bifrost: a nested `reasoning: { effort }` object whose values run
 *   `none` through `xhigh`; the app's low/medium/high map directly.
 * A missing level defaults to `medium` — both openai and bifrost treat
 * that as their standard reasoning setting.
 */
const reasoningEffort = (
  conn: ProviderConnectionRow,
  level: ThinkingLevel | undefined,
): Record<string, unknown> | undefined => {
  const effort = level ?? 'medium';
  if (effort === 'off') return undefined;
  if (conn.compatibility === 'bifrost') {
    return { reasoning: { effort } };
  }
  return { reasoning_effort: effort };
};

async function* chatCompletions(
  conn: ProviderConnectionRow,
  model: string,
  thinkingLevel: ThinkingLevel | undefined,
  history: Turn[],
  tools: ReturnType<typeof toolSpec>[],
  step: number,
  stop: AbortSignal,
): AsyncGenerator<
  GenEvent,
  {
    text: string;
    calls: WireCall[];
    usage?: MessageUsage;
    usageDetails?: MessageUsageDetails;
    routing?: MessageRouting;
    refusal?: string;
    annotations?: UrlCitation[];
  }
> {
  const idle = new AbortController();
  let idleTimer = setTimeout(() => idle.abort(), IDLE_MS);
  const bump = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => idle.abort(), IDLE_MS);
  };
  try {
    const apiKey = decryptSecret(conn.apiKey);
    const res = await fetch(
      `${conn.baseUrl}${COMPLETIONS_PATH[conn.compatibility]}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'user-agent': USER_AGENT,
          /* opt into openrouter routing metadata so `routing` can be captured;
             attribution headers list the app in openrouter's rankings */
          ...(conn.compatibility === 'openrouter'
            ? { 'X-OpenRouter-Metadata': 'enabled', ...OPENROUTER_ATTRIBUTION }
            : {}),
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: history,
          stream: true,
          stream_options: { include_usage: true },
          ...(tools.length > 0 ? { tools } : {}),
          ...(reasoningEffort(conn, thinkingLevel) ?? {}),
        }),
        signal: AbortSignal.any([stop, idle.signal]),
      },
    );
    if (!res.ok || !res.body) {
      const body = (await res.text().catch(() => '')).slice(0, 300);
      throw new Error(`${conn.name} → ${res.status}${body ? `: ${body}` : ''}`);
    }
    const dec = new TextDecoder();
    let buf = '';
    let text = '';
    /* tool calls stream in fragments keyed by index: id and name first, then argument chunks */
    const partial: PartialCall[] = [];
    let usage: MessageUsage | undefined;
    let usageDetails: MessageUsageDetails | undefined;
    let routing: MessageRouting | undefined;
    /* a refusal replaces the answer; web-search citations arrive whole in the final chunk */
    let refusal = '';
    const annotations: UrlCitation[] = [];
    const result = () => {
      const calls = partial
        .filter((c) => c.name)
        .map((c) =>
          toWire({
            id: c.id || `call_${crypto.randomUUID().slice(0, 8)}`,
            name: c.name,
            args: c.args,
          }),
        );
      return {
        text,
        calls,
        ...(usage ? { usage } : {}),
        ...(usageDetails ? { usageDetails } : {}),
        ...(routing ? { routing } : {}),
        ...(refusal ? { refusal } : {}),
        ...(annotations.length > 0 ? { annotations } : {}),
      };
    };
    for await (const chunk of res.body) {
      bump();
      buf += dec.decode(chunk, { stream: true });
      /* sse frames are separated by a blank line; `data:` may span several lines (bifrost pretty-prints) */
      let frame = /^(.*?)\r?\n\r?\n/s.exec(buf);
      while (frame) {
        const block = frame[1] ?? '';
        buf = buf.slice(frame[0].length);
        frame = /^(.*?)\r?\n\r?\n/s.exec(buf);
        const data = sseData(block).trim();
        if (data === '') continue;
        if (data === '[DONE]') return result();
        const json = JSON.parse(data) as {
          error?: { message?: string };
          model?: string;
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            total_tokens?: number;
            prompt_cache_hit_tokens?: number;
            cache_read_input_tokens?: number;
            prompt_tokens_details?: {
              audio_tokens?: number;
              image_tokens?: number;
              cached_read_tokens?: number;
              cached_write_tokens?: number;
            };
            completion_tokens_details?: {
              reasoning_tokens?: number;
              audio_tokens?: number;
              image_tokens?: number;
              citation_tokens?: number;
              accepted_prediction_tokens?: number;
              rejected_prediction_tokens?: number;
              num_search_queries?: number;
            };
            cost?: ReportedCost;
          };
          /* bifrost: routing/latency extras on the last chunk */
          extra_fields?: {
            provider?: string;
            model_requested?: string;
            model_deployment?: string;
            latency?: number;
          };
          /* openrouter: routing metadata when opt-in header is set */
          openrouter_metadata?: {
            strategy?: string;
            requested?: string;
            endpoints?: {
              selected?: { provider?: string; model?: string };
              available?: { provider?: string; model?: string }[];
            }[];
          };
          choices?: {
            delta?: {
              content?: string | null;
              refusal?: string | null;
              reasoning?: string | null;
              reasoning_content?: string | null;
              tool_calls?: {
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }[];
            };
            message?: {
              annotations?: {
                type?: string;
                url_citation?: {
                  url?: string;
                  title?: string;
                  start_index?: number;
                  end_index?: number;
                };
              }[];
            };
          }[];
        };
        /* usage is on the last non-[DONE] chunk */
        if (json.usage) {
          const cached =
            json.usage.prompt_cache_hit_tokens ??
            json.usage.cache_read_input_tokens;
          const reasoning =
            json.usage.completion_tokens_details?.reasoning_tokens;
          const cost = reportedCost(json.usage.cost);
          usage = {
            promptTokens: json.usage.prompt_tokens ?? 0,
            completionTokens: json.usage.completion_tokens ?? 0,
            totalTokens: json.usage.total_tokens ?? 0,
            ...(cached != null && cached > 0 ? { cachedTokens: cached } : {}),
            ...(reasoning != null && reasoning > 0
              ? { reasoningTokens: reasoning }
              : {}),
            ...(cost != null ? { costUsd: cost } : {}),
          };
          /* the granular token/cost splits live in a separate jsonb column */
          const pd = json.usage.prompt_tokens_details;
          const cd = json.usage.completion_tokens_details;
          const promptDetails = pd
            ? {
                ...(pd.audio_tokens != null
                  ? { audioTokens: pd.audio_tokens }
                  : {}),
                ...(pd.image_tokens != null
                  ? { imageTokens: pd.image_tokens }
                  : {}),
                ...(pd.cached_read_tokens != null
                  ? { cachedReadTokens: pd.cached_read_tokens }
                  : {}),
                ...(pd.cached_write_tokens != null
                  ? { cachedWriteTokens: pd.cached_write_tokens }
                  : {}),
              }
            : undefined;
          const completionDetails = cd
            ? {
                ...(cd.audio_tokens != null
                  ? { audioTokens: cd.audio_tokens }
                  : {}),
                ...(cd.reasoning_tokens != null
                  ? { reasoningTokens: cd.reasoning_tokens }
                  : {}),
                ...(cd.accepted_prediction_tokens != null
                  ? { acceptedPredictionTokens: cd.accepted_prediction_tokens }
                  : {}),
                ...(cd.rejected_prediction_tokens != null
                  ? { rejectedPredictionTokens: cd.rejected_prediction_tokens }
                  : {}),
                ...(cd.citation_tokens != null
                  ? { citationTokens: cd.citation_tokens }
                  : {}),
                ...(cd.image_tokens != null
                  ? { imageTokens: cd.image_tokens }
                  : {}),
                ...(cd.num_search_queries != null
                  ? { searchQueries: cd.num_search_queries }
                  : {}),
              }
            : undefined;
          const costBreakdown: MessageUsageDetails['cost'] = json.usage.cost
            ? {
                ...(json.usage.cost.input_tokens_cost != null
                  ? { inputTokens: json.usage.cost.input_tokens_cost }
                  : {}),
                ...(json.usage.cost.output_tokens_cost != null
                  ? { outputTokens: json.usage.cost.output_tokens_cost }
                  : {}),
                ...(json.usage.cost.reasoning_tokens_cost != null
                  ? { reasoningTokens: json.usage.cost.reasoning_tokens_cost }
                  : {}),
                ...(json.usage.cost.citation_tokens_cost != null
                  ? { citationTokens: json.usage.cost.citation_tokens_cost }
                  : {}),
                ...(json.usage.cost.search_queries_cost != null
                  ? { searchQueries: json.usage.cost.search_queries_cost }
                  : {}),
                ...(json.usage.cost.request_cost != null
                  ? { request: json.usage.cost.request_cost }
                  : {}),
                ...(json.usage.cost.total_cost != null
                  ? { total: json.usage.cost.total_cost }
                  : {}),
              }
            : undefined;
          if (promptDetails || completionDetails || nonEmptyCost(costBreakdown))
            usageDetails = {
              ...(promptDetails ? { promptDetails } : {}),
              ...(completionDetails ? { completionDetails } : {}),
              ...(nonEmptyCost(costBreakdown) ? { cost: costBreakdown! } : {}),
            };
        }
        /* bifrost routing extras */
        if (json.extra_fields) {
          const ef = json.extra_fields;
          const next: MessageRouting = {};
          if (typeof ef.provider === 'string') next.provider = ef.provider;
          if (typeof ef.model_requested === 'string')
            next.modelRequested = ef.model_requested;
          if (typeof ef.model_deployment === 'string')
            next.modelDeployment = ef.model_deployment;
          if (typeof ef.latency === 'number') next.latencyMs = ef.latency;
          if (Object.keys(next).length > 0) routing = { ...routing, ...next };
        }
        /* openrouter routing metadata */
        if (json.openrouter_metadata) {
          const md = json.openrouter_metadata;
          const selected = md.endpoints?.find((e) => e.selected)?.selected;
          const next: MessageRouting = {
            ...(md.strategy ? { strategy: md.strategy } : {}),
            ...(json.model ? { modelRequested: json.model } : {}),
            ...(selected?.provider ? { routeProvider: selected.provider } : {}),
          };
          if (Object.keys(next).length > 0) routing = { ...routing, ...next };
        }
        /* some providers report failures mid-stream as a data frame */
        if (json.error)
          throw new Error(json.error.message ?? 'upstream stream error');
        const delta = json.choices?.[0]?.delta;
        /* openrouter and ollama call it `reasoning`; lm studio, deepseek and vllm `reasoning_content` */
        const thought = delta?.reasoning || delta?.reasoning_content;
        if (thought) yield { type: 'reasoning', step, text: thought };
        if (delta?.content) {
          text += delta.content;
          yield { type: 'text', text: delta.content };
        }
        if (delta?.refusal) refusal += delta.refusal;
        /* citations come on the complete message, not the delta */
        for (const a of json.choices?.[0]?.message?.annotations ?? []) {
          const c = a.url_citation;
          if (a.type === 'url_citation' && c?.url)
            annotations.push({
              url: c.url,
              title: c.title ?? c.url,
              startIndex: c.start_index ?? 0,
              endIndex: c.end_index ?? 0,
            });
        }
        for (const tc of delta?.tool_calls ?? []) {
          /* servers that send whole calls may omit the index; a fresh id means a new call */
          const i =
            tc.index ??
            (tc.id || partial.length === 0
              ? partial.length
              : partial.length - 1);
          const c = partial[i] ?? { id: '', name: '', args: '' };
          partial[i] = c;
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name = tc.function.name;
          if (tc.function?.arguments) c.args += tc.function.arguments;
        }
      }
    }
    /* a trailing frame may lack the blank-line terminator (usually just [DONE]) */
    if (sseData(buf).trim() === '[DONE]') return result();
    return result();
  } catch (e) {
    /* the idle abort surfaces as an AbortError; name the real cause */
    if (idle.signal.aborted && !stop.aborted)
      throw new Error(`${conn.name} stopped responding`);
    throw e;
  } finally {
    clearTimeout(idleTimer);
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

/* demo catalog models have no backend — stream a canned reply so the composer stays usable */
async function* mockReply(
  modelId: string,
  signal: AbortSignal,
): AsyncGenerator<string> {
  const reply =
    `This is a simulated reply from ${modelId}. No provider connection serves this model, ` +
    `so the server streams placeholder text instead. Add a provider in Settings to talk to a real model.\n\n` +
    `The stream runs on the server, so you can refresh or close the tab and reopen this chat — ` +
    `it picks up from wherever the reply has got to.`;
  let i = 0;
  while (i < reply.length) {
    await sleep(40, signal);
    const n = 2 + Math.floor(Math.random() * 5);
    yield reply.slice(i, i + n);
    i += n;
  }
}

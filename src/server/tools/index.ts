/*
 * tools/index — the registry that turns stored tools into model-callable
 * functions, and the pipeline that runs one call.
 *
 * Business logic:
 * - a tool reaches the model only when the user's grant (sent with every
 *   request) enables it and at least one of its backends is usable;
 *   toolStatuses reports the rest to the settings ui with the reason
 *   ("no key configured for …", "not implemented yet").
 * - loadToolAuth resolves credentials once per run: the user's own key from
 *   tool_credentials (opened with decryptSecret) always wins; otherwise an
 *   env-defined key (TAVILY_API_KEY, GITHUB_PAT, …) applies only when the
 *   site's env-key policy admits it for this user. backends with no key
 *   (`default`, `direct`) are always usable.
 * - resolveTools then picks the backend per tool — the user's saved provider
 *   if it is still usable, else the first usable one — and attaches the
 *   resolved key, the user's result-count preference, and, for
 *   web_search/http_fetch only, the shared-key flag and per-tool
 *   concurrency preference.
 * - invokeTool never throws: an unknown tool, non-JSON or non-object args,
 *   and any run error come back as "error: …" result text the model can
 *   react to instead of killing the reply.
 * - the model sees only `result`, truncated at RESULT_MAX (20k chars) so one
 *   big page can't eat the context; the untouched upstream response rides
 *   along as `raw`, truncated at RAW_MAX (1.5M), for the ui — artifact
 *   snapshots are persisted there, so a 1M-char artifact survives json
 *   escaping.
 * - a call carrying a concurrency preference runs under withConcurrency,
 *   scoped `user:<id>:<tool>` for an own key or `shared:<provider>:<tool>`
 *   for an env key, so users of a shared system key throttle together;
 *   without the preference there is no throttling.
 * - every run gets the signal, messageId/callId/chatId/userId and calls() —
 *   this reply's calls so far, including ones a retry carried over — so
 *   tools can wait on the user (ask_user) or rebuild branch state
 *   (artifact) without touching other users' data.
 * - toolSpec shapes an ActiveTool into the openai function-tool entry the
 *   completions call expects.
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../../db';
import { toolCredentials } from '../../db/schema';
import { TOOLS } from '../../lib/tools';
import type { ProviderId, ToolCall, ToolId, ToolStatus } from '../../types';
import { decryptSecret } from '../secrets';
import {
  envKeysShared,
  envKeyValue,
  providerKeyDefs,
} from '../tool-credentials';
import { loadToolPreferences } from '../tool-preferences';
import { artifact } from './artifact';
import { askUser } from './ask-user';
import { chatSearch } from './chat-search';
import { withConcurrency } from './concurrency';
import { getCurrentTimestamp } from './get-current-timestamp';
import {
  githubDiscussionSearch,
  githubFileFetch,
  githubIssueSearch,
  githubPrSearch,
  githubRepoSearch,
} from './github';
import { httpFetch } from './http-fetch';
import { memory } from './memory';
import { todo } from './todo';
import { webSearch } from './web-search';

export type ToolContext = {
  signal: AbortSignal;
  /* the reply and call being served, for tools that wait on the user */
  messageId: string;
  callId: string;
  /* the chat the reply belongs to; tools that touch stored data stay within it */
  chatId: string;
  /* the user the reply is for; tools that touch stored data stay within it */
  userId: string;
  /* the calls this reply has made so far, including ones carried over by a retry */
  calls: () => ToolCall[];
  /* the backend the user picked; tools fall back to any configured one */
  provider?: ProviderId | undefined;
  /* the api key for the active backend, resolved server-side */
  apiKey?: string | undefined;
  /* per-tool preferences for the acting user (e.g. web_search result count) */
  count?: number | undefined;
  /* web_search/http_fetch concurrency: how many may run at once for this user */
  concurrency?: number | undefined;
  /* true when the acting key is an environment-defined (shared) system key */
  shared?: boolean | undefined;
};

/* `result` goes to the model; `raw` is the untouched upstream response, for the ui */
export type ToolOutput = string | { result: string; raw?: string | undefined };

/**
 * a credential-backed backend a tool can route through. `key` names a provider in the
 * tool-credentials registry; the server resolves its key for the acting user and hands
 * it to `run` as `ctx.apiKey`. providers without a key (`default`, `direct`, …) are
 * listed here with `keyed: false` and always usable.
 */
export type ToolProvider = {
  id: ProviderId;
  /* provider-key id in the registry, or null when the backend needs no key */
  key?: ProviderId | undefined;
};

/** a tool the model can call; `run` returns the text handed back to it */
export type ServerTool = {
  id: ToolId;
  /* written for the model, unlike the short ui description in lib/tools */
  description: string;
  /* json schema of the arguments object */
  parameters: Record<string, unknown>;
  /* all backends the tool can route through; the server filters these to the ones
     the acting user actually has a key for */
  backends: () => ToolProvider[];
  /* required backends: when non-empty the tool is disabled unless at least one is usable */
  required?: boolean | undefined;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;
};

/* what a tool can do for a specific user */
export type ToolAuth = {
  userId: string;
  admin: boolean;
  /* provider-key ids this user may use (own key or an admissible env key) */
  usableKeys: Map<ProviderId, string>;
  /* provider-key ids whose key is the shared environment-defined one */
  sharedKeys: Set<ProviderId>;
};

/** loads the credentials a user may use: their own keys plus env keys per policy */
export const loadToolAuth = async (
  userId: string,
  admin: boolean,
): Promise<ToolAuth> => {
  const rows = await getDb()
    .select({
      provider: toolCredentials.provider,
      apiKey: toolCredentials.apiKey,
    })
    .from(toolCredentials)
    .where(eq(toolCredentials.userId, userId));
  const own = new Map(rows.map((r) => [r.provider, r.apiKey]));

  const shared = await envKeysShared(admin);

  const usableKeys = new Map<ProviderId, string>();
  const sharedKeys = new Set<ProviderId>();
  for (const def of providerKeyDefs()) {
    const ownKey = own.get(def.id);
    if (ownKey) {
      usableKeys.set(def.id, decryptSecret(ownKey) ?? '');
      continue;
    }
    const env = shared ? envKeyValue(def.env) : undefined;
    if (env) {
      usableKeys.set(def.id, env);
      sharedKeys.add(def.id);
    }
  }
  return { userId, admin, usableKeys, sharedKeys };
};

export type ActiveTool = {
  tool: ServerTool;
  provider?: ProviderId | undefined;
  /* the resolved key for the chosen backend, when it needs one */
  apiKey?: string | undefined;
  /* per-tool preferences for the acting user (e.g. web_search result count) */
  count?: number | undefined;
  /* web_search/http_fetch concurrency, from the user's preference (default 5) */
  concurrency?: number | undefined;
  /* true when the resolved key is the shared environment-defined one */
  shared?: boolean | undefined;
};

const REGISTRY = new Map<ToolId, ServerTool>(
  [
    artifact,
    askUser,
    chatSearch,
    githubDiscussionSearch,
    githubFileFetch,
    githubIssueSearch,
    githubPrSearch,
    githubRepoSearch,
    getCurrentTimestamp,
    httpFetch,
    memory,
    todo,
    webSearch,
  ].map((t) => [t.id, t]),
);

/* results are capped so one big page can't eat the context window */
export const RESULT_MAX = 20_000;
/* raw responses only feed the ui, so they get more room (artifact snapshots live here) */
export const RAW_MAX = 1_500_000;

export const truncate = (s: string, max = RESULT_MAX) =>
  s.length <= max
    ? s
    : `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;

/** the backends of a tool the given auth can actually use */
const usableBackends = (tool: ServerTool, auth: ToolAuth): ToolProvider[] =>
  tool.backends().filter((b) => !b.key || auth.usableKeys.has(b.key));

/** the reason a tool can't run for this auth; undefined means ready */
const unavailable = (tool: ServerTool, auth: ToolAuth): string | undefined => {
  const usable = usableBackends(tool, auth);
  if (usable.length > 0) return undefined;
  const keyed = tool.backends().filter((b) => b.key);
  if (keyed.length === 0) return undefined;
  const names = keyed.map((b) => b.key).join(', ');
  return `no key configured for ${names}`;
};

export const toolStatuses = (auth: ToolAuth): ToolStatus[] =>
  TOOLS.map((t) => {
    const impl = REGISTRY.get(t.id);
    if (!impl)
      return { id: t.id, available: false, reason: 'not implemented yet' };
    const reason = unavailable(impl, auth);
    return {
      id: t.id,
      available: reason === undefined,
      ...(reason ? { reason } : {}),
      ...(impl.backends().length > 0
        ? { providers: usableBackends(impl, auth).map((b) => b.id) }
        : {}),
    };
  });

/** the granted tools that can actually run, with the chosen backend and its key */
export const resolveTools = async (
  grants: Record<ToolId, boolean>,
  providers: Record<ToolId, ProviderId>,
  auth: ToolAuth,
): Promise<ActiveTool[]> => {
  const prefs = await loadToolPreferences(auth.userId);
  const counts = prefs.counts;
  const out: ActiveTool[] = [];
  for (const tool of [...REGISTRY.values()]) {
    if (grants[tool.id] !== true || unavailable(tool, auth) !== undefined)
      continue;
    const provider = pickProvider(tool, providers[tool.id], auth);
    const backend = tool.backends().find((b) => b.id === provider);
    const apiKey = backend?.key ? auth.usableKeys.get(backend.key) : undefined;
    const count = counts[tool.id];
    const shared = backend?.key ? auth.sharedKeys.has(backend.key) : false;
    const throttled = tool.id === 'web_search' || tool.id === 'http_fetch';
    const concurrency = prefs.concurrency[tool.id];
    out.push({
      tool,
      provider,
      ...(apiKey ? { apiKey } : {}),
      ...(count !== undefined ? { count } : {}),
      ...(throttled ? { shared } : {}),
      ...(throttled && concurrency !== undefined ? { concurrency } : {}),
    });
  }
  return out;
};

/* the client's saved backend, or the first usable one if it lost its key since */
const pickProvider = (
  tool: ServerTool,
  chosen: ProviderId | undefined,
  auth: ToolAuth,
): ProviderId | undefined => {
  const usable = usableBackends(tool, auth);
  if (usable.length === 0) return undefined;
  if (chosen && usable.some((b) => b.id === chosen)) return chosen;
  return usable[0]?.id;
};

/** runs one call; never throws, so a failing tool becomes a message the model can react to */
export const invokeTool = async (
  name: string,
  rawArgs: string,
  tools: ActiveTool[],
  ctx: Omit<ToolContext, 'provider' | 'apiKey'>,
): Promise<{ ok: boolean; result: string; raw?: string; ms: number }> => {
  const t0 = Date.now();
  const done = (ok: boolean, result: string, raw?: string) => ({
    ok,
    result: truncate(result),
    ...(raw !== undefined ? { raw: truncate(raw, RAW_MAX) } : {}),
    ms: Date.now() - t0,
  });
  const active = tools.find((t) => t.tool.id === name);
  if (!active) return done(false, `error: tool "${name}" is not available`);
  let args: unknown;
  try {
    args = JSON.parse(rawArgs || '{}');
  } catch {
    return done(false, 'error: arguments are not valid JSON');
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args))
    return done(false, 'error: arguments must be a JSON object');
  try {
    const run = async () =>
      active.tool.run(args as Record<string, unknown>, {
        ...ctx,
        provider: active.provider,
        ...(active.apiKey ? { apiKey: active.apiKey } : {}),
        ...(active.count !== undefined ? { count: active.count } : {}),
      });
    const out =
      active.concurrency !== undefined
        ? await withConcurrency(
            active.shared
              ? `shared:${active.provider ?? 'unknown'}:${name}`
              : `user:${ctx.userId}:${name}`,
            active.concurrency,
            ctx.signal,
            run,
          )
        : await run();
    return typeof out === 'string'
      ? done(true, out)
      : done(true, out.result, out.raw);
  } catch (e) {
    return done(false, `error: ${e instanceof Error ? e.message : String(e)}`);
  }
};

/** openai `tools` entry */
export const toolSpec = ({ tool }: ActiveTool) => ({
  type: 'function' as const,
  function: {
    name: tool.id,
    description: tool.description,
    parameters: tool.parameters,
  },
});

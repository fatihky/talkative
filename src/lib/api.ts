/*
 * api — the client's typed door to every /api route.
 *
 * Business logic:
 * - Client-only (stores and components); no server code imports it. The
 *   resource groups (providersApi, chatsApi, foldersApi, notesApi,
 *   decisionsApi, artifactsApi, memoriesApi, settingsApi,
 *   toolPreferencesApi, toolCredentialsApi, userPreferencesApi, usersApi,
 *   modelOverridesApi) are thin verbs over `request`, while the fetch*
 *   wrappers add the dev-flag behaviour the boot sequence needs.
 * - `request` is the single error contract: JSON in and out, a non-2xx
 *   becomes ApiError(status, body.error), a failed fetch becomes
 *   ApiError(0, …) so callers can read status 0 as "offline", and 204
 *   resolves undefined.
 * - DevFlags are the status-bar debugger's switches: each fetch* checks
 *   them first to fake a dead catalog, offline, 4× latency, empty
 *   chats/suggestions, rate limits or degraded provider health. They live
 *   in the network store and never reach the server; a message whose text
 *   contains `[fail]` also forces a send error.
 * - fetchModels falls back to the demo MODELS catalog when the server
 *   reports zero provider connections, so a fresh install still has a
 *   usable composer. Catalog errors come back keyed by connection id and
 *   items may still be served stale from the server's cache.
 * - sendMessage, regenerateMessage and retryToolCall only store the turn
 *   and start the run; they resolve with the still-empty assistant message
 *   and the text arrives over SSE. regenerate answers the same user turn
 *   again as a sibling branch, retry continues from a failed tool call.
 * - readStream resumes at a character `offset` — the text already received
 *   — and resolves null when the connection drops, because the run keeps
 *   going server-side; the caller reconnects with the new offset and backs
 *   off. Only a `done` frame resolves StreamEnd (status, usage, refusal,
 *   citations), and an explicit abort rethrows instead of returning null.
 * - Frames are split on blank lines and read one `event:`/`data:` line
 *   each; bare comment frames are heartbeats and are skipped.
 * - uploadAttachment posts multipart straight through fetch (request would
 *   force a JSON content-type) under the client-minted attachment id, and
 *   returns the metadata it was handed rather than the response body.
 */
import type {
  AdminUser,
  Attachment,
  ChatDetail,
  ChatSummary,
  DecisionQuestion,
  DecisionRun,
  Folder,
  Memory,
  Message,
  MessageStatus,
  Model,
  ModelCapabilities,
  ModelKind,
  ModelOverrideDto,
  ModelPricing,
  Note,
  Provider,
  ProviderConnection,
  ProviderConnectionInput,
  PublicArtifact,
  SiteSettings,
  Suggestion,
  ThinkingLevel,
  Thought,
  ToolCall,
  ToolCredential,
  ToolPreferences,
  ToolProviderKey,
  ToolStatus,
  UrlCitation,
  UserPrefs,
} from '../types';
import type { ArtifactSnapshot } from './artifacts';
import { MODELS } from './mock';

export type DevFlags = {
  failCatalog: boolean;
  failSend: boolean;
  simulateOffline: boolean;
  slowNetwork: boolean;
  emptyChats: boolean;
  emptySuggestions: boolean;
  rateLimited: boolean;
  degraded: boolean;
};

export const defaultDevFlags = (): DevFlags => ({
  failCatalog: false,
  failSend: false,
  simulateOffline: false,
  slowNetwork: false,
  emptyChats: false,
  emptySuggestions: false,
  rateLimited: false,
  degraded: false,
});

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const base = (dev: DevFlags, ms: number) =>
  delay(dev.slowNetwork ? ms * 4 : ms);

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
  } catch (e) {
    throw new ApiError(0, e instanceof Error ? e.message : 'network error');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new ApiError(res.status, body?.error ?? `${path} → ${res.status}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export type SearchHit = {
  id: string;
  chatId: string;
  chatTitle: string;
  folderId: string | null;
  role: 'user' | 'assistant';
  modelId: string | null;
  createdAt: number;
  /* matches wrapped in MARK_START/MARK_END (lib/search.ts), never html */
  snippet: string;
  /* the reply text, or its reasoning/tool output (only with `extra`) */
  in: 'content' | 'extra';
};

export type SearchResults = {
  chats: { id: string; title: string; updatedAt: number }[];
  messages: SearchHit[];
  /* the query's positive words, for highlighting inside the opened thread */
  terms: string[];
  next: number | null;
};

export type SearchParams = {
  q: string;
  role?: 'user' | 'assistant' | undefined;
  chat?: string | undefined;
  folder?: string | undefined;
  model?: string | undefined;
  after?: string | undefined;
  before?: string | undefined;
  extra?: boolean | undefined;
  sort?: 'relevance' | 'newest' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
};

export const searchApi = {
  search: (p: SearchParams, signal?: AbortSignal) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(p))
      if (v !== undefined && v !== '' && v !== false)
        qs.set(k, v === true ? '1' : String(v));
    return request<SearchResults>(`/api/search?${qs}`, {
      signal: signal ?? null,
    });
  },
};

export type CatalogResponse = {
  items: Model[];
  syncedAt: number;
  providerCount: number;
  /* connection id → upstream error (items may still be served stale from cache) */
  errors: Record<string, string>;
};

export async function fetchModels(
  dev: DevFlags,
  opts: { refresh?: boolean } = {},
): Promise<{
  items: Model[];
  syncedAt: number;
  errors: Record<string, string>;
}> {
  if (dev.slowNetwork) await delay(1500);
  if (dev.failCatalog)
    throw new ApiError(
      503,
      'Model catalog unavailable (simulated provider 5xx)',
    );
  const res = await request<CatalogResponse>(
    `/api/models${opts.refresh ? '?refresh=1' : ''}`,
  );
  /* no providers configured yet — keep the demo catalog so the composer stays usable */
  if (res.providerCount === 0)
    return {
      items: MODELS.map((m) => ({ ...m })),
      syncedAt: Date.now(),
      errors: {},
    };
  return { items: res.items, syncedAt: res.syncedAt, errors: res.errors };
}

export const providersApi = {
  list: () => request<ProviderConnection[]>('/api/providers'),
  create: (input: ProviderConnectionInput) =>
    request<ProviderConnection>('/api/providers', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  update: (id: number, input: ProviderConnectionInput) =>
    request<ProviderConnection>(`/api/providers/${id}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  setEnabled: (id: number, enabled: boolean) =>
    request<ProviderConnection>(`/api/providers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    }),
  remove: (id: number) =>
    request<void>(`/api/providers/${id}`, { method: 'DELETE' }),
  models: (id: number, refresh = false) =>
    request<{ items: Model[]; syncedAt: number; error?: string }>(
      `/api/providers/${id}/models${refresh ? '?refresh=1' : ''}`,
    ),
};

/** the connection and display name behind a namespaced `${connectionId}:${remoteId}` model id */
export const modelOrigin = (
  id: string,
  connections: Pick<ProviderConnection, 'id' | 'name'>[],
  models: Pick<Model, 'id' | 'shortName'>[] = [],
): { provider: string; model: string } => {
  const [, conn, remoteId] = /^(\d+):(.+)$/.exec(id) ?? [];
  return {
    provider: connections.find((c) => String(c.id) === conn)?.name ?? '',
    model: models.find((m) => m.id === id)?.shortName ?? remoteId ?? id,
  };
};

export type ModelOverridesResponse = {
  /* the catalog with the caller's overrides applied, custom models included */
  items: Model[];
  /* models left out because the user hid them, with their connection name */
  hidden: { id: string; provider?: string | undefined }[];
  syncedAt: number;
  connections: { id: number; name: string }[];
};

/* model ids address rows, and a catalog id may contain '/' — encoded for the path */
const overridePath = (id: string) =>
  `/api/model-overrides/${encodeURIComponent(id)}`;

/** a PUT body; unset keys (or null) mean "keep what the provider reports" */
export type ModelOverrideInput = {
  custom?: boolean;
  connectionId?: number;
  remoteId?: string;
  baseUrl?: string;
  kind?: ModelKind;
  shortName?: string;
  contextWindow?: number;
  maxOutput?: number;
  thinkingLevels?: ThinkingLevel[];
  defaultThinkingLevel?: ThinkingLevel;
  params?: string;
  capabilities?: Partial<ModelCapabilities>;
  pricing?: Partial<ModelPricing>;
  hidden?: boolean;
};
/* callers build a body by spreading conditionally, so keys may be undefined */
export type ModelOverrideBody = {
  [K in keyof ModelOverrideInput]?: ModelOverrideInput[K] | undefined;
};

export const modelOverridesApi = {
  list: () => request<ModelOverridesResponse>('/api/model-overrides'),
  save: (id: string, override: ModelOverrideBody) =>
    request<ModelOverrideDto>(overridePath(id), {
      method: 'PUT',
      body: JSON.stringify(override),
    }),
  /* back to what the provider reports, or forget a custom model */
  remove: (id: string) =>
    request<void>(overridePath(id), { method: 'DELETE' }),
};

export async function fetchModelOverrides(opts: {
  refresh?: boolean;
}): Promise<ModelOverridesResponse> {
  return request<ModelOverridesResponse>(
    `/api/model-overrides${opts.refresh ? '?refresh=1' : ''}`,
  );
}

export const chatsApi = {
  list: () => request<ChatSummary[]>('/api/chats'),
  get: (id: string) => request<ChatDetail>(`/api/chats/${id}`),
  patch: (
    id: string,
    patch: {
      title?: string;
      category?: string | null;
      tags?: string[];
      folderId?: string | null;
      leafId?: string;
      systemPrompt?: string | null;
      pinned?: boolean;
    },
  ) =>
    request<ChatSummary>(`/api/chats/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  remove: (id: string) =>
    request<void>(`/api/chats/${id}`, { method: 'DELETE' }),
};

export const foldersApi = {
  list: () => request<Folder[]>('/api/folders'),
  create: (input: { id: string; name: string; parentId: string | null }) =>
    request<Folder>('/api/folders', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  patch: (
    id: string,
    patch: {
      name?: string;
      parentId?: string | null;
      systemPrompt?: string | null;
    },
  ) =>
    request<Folder>(`/api/folders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  remove: (id: string) =>
    request<void>(`/api/folders/${id}`, { method: 'DELETE' }),
};

export const notesApi = {
  list: () => request<Note[]>('/api/notes'),
  create: (input: { id: string; title: string; text: string }) =>
    request<Note>('/api/notes', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  patch: (id: string, patch: { title?: string; text?: string }) =>
    request<Note>(`/api/notes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  remove: (id: string) =>
    request<void>(`/api/notes/${id}`, { method: 'DELETE' }),
};

export const decisionsApi = {
  list: () => request<DecisionRun[]>('/api/decisions'),
  /** stores the run and evaluates it; a failed evaluation resolves with `error` set on the run */
  evaluate: (input: {
    id?: string;
    modelId: string;
    title?: string;
    input: string;
    questions: DecisionQuestion[];
  }) =>
    request<DecisionRun>('/api/decisions', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  patch: (id: string, patch: { title: string }) =>
    request<DecisionRun>(`/api/decisions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  remove: (id: string) =>
    request<void>(`/api/decisions/${id}`, { method: 'DELETE' }),
};

export const artifactsApi = {
  list: () => request<PublicArtifact[]>('/api/artifacts'),
  publish: (input: {
    artifactId: string;
    title: string;
    kind: ArtifactSnapshot['kind'];
    language?: string;
    content: string;
    version: number;
    chatId?: string;
    messageId?: string;
    callId?: string;
    leafId?: string;
  }) =>
    request<PublicArtifact>('/api/artifacts', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  setPublished: (id: number, published: boolean) =>
    request<PublicArtifact>(`/api/artifacts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ published }),
    }),
  remove: (id: number) =>
    request<void>(`/api/artifacts/${id}`, { method: 'DELETE' }),
};

export const memoriesApi = {
  list: () => request<Memory[]>('/api/memories'),
  create: (input: { key: string; value: string }) =>
    request<Memory>('/api/memories', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  patch: (id: string, patch: { key?: string; value?: string }) =>
    request<Memory>(`/api/memories/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  remove: (id: string) =>
    request<void>(`/api/memories/${id}`, { method: 'DELETE' }),
  clear: () => request<void>('/api/memories', { method: 'DELETE' }),
};

export async function fetchNotes(dev: DevFlags): Promise<Note[]> {
  if (dev.simulateOffline) throw new ApiError(0, 'offline');
  return notesApi.list();
}

/** the /decisions screens refetch on mount, so this only carries the offline simulation */
export async function fetchDecisions(dev: DevFlags): Promise<DecisionRun[]> {
  if (dev.simulateOffline) throw new ApiError(0, 'offline');
  return decisionsApi.list();
}

export async function fetchChats(dev: DevFlags): Promise<ChatSummary[]> {
  if (dev.slowNetwork) await delay(1000);
  if (dev.simulateOffline) throw new ApiError(0, 'offline');
  if (dev.emptyChats) return [];
  return chatsApi.list();
}

export async function fetchTools(dev: DevFlags): Promise<ToolStatus[]> {
  if (dev.simulateOffline) throw new ApiError(0, 'offline');
  return (await request<{ items: ToolStatus[] }>('/api/tools')).items;
}

export const toolPreferencesApi = {
  get: () => request<ToolPreferences>('/api/tool-preferences'),
  put: (prefs: ToolPreferences) =>
    request<ToolPreferences>('/api/tool-preferences', {
      method: 'PUT',
      body: JSON.stringify(prefs),
    }),
};

export const userPreferencesApi = {
  get: () => request<UserPrefs>('/api/user-preferences'),
  patch: (patch: UserPrefs) =>
    request<UserPrefs>('/api/user-preferences', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
};

/* applied to the prefs store at boot; an offline simulated boot skips it */
export async function fetchUserPrefs(dev: DevFlags): Promise<UserPrefs> {
  if (dev.simulateOffline) throw new ApiError(0, 'offline');
  return userPreferencesApi.get();
}

export type SiteSettingsResponse = SiteSettings & {
  isAdmin: boolean;
  hasUsers: boolean;
};

export const settingsApi = {
  get: () => request<SiteSettingsResponse>('/api/settings'),
  patch: (patch: Partial<SiteSettings>) =>
    request<SiteSettings>('/api/settings', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
};

export type ToolCredentialsResponse = {
  items: ToolCredential[];
  providers: ToolProviderKey[];
  isAdmin: boolean;
};

export const toolCredentialsApi = {
  get: () => request<ToolCredentialsResponse>('/api/tool-credentials'),
  put: (input: { provider: string; apiKey?: string | null }) =>
    request<ToolCredential>('/api/tool-credentials', {
      method: 'PUT',
      body: JSON.stringify(input),
    }),
  remove: (provider: string) =>
    request<void>(
      `/api/tool-credentials?provider=${encodeURIComponent(provider)}`,
      { method: 'DELETE' },
    ),
};

export const usersApi = {
  list: () => request<AdminUser[]>('/api/users'),
  create: (input: { name: string; email: string; password: string }) =>
    request<AdminUser>('/api/users', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  update: (id: string, patch: { email?: string; name?: string }) =>
    request<AdminUser>(`/api/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
};

export const fetchRegistrationStatus = () =>
  request<{ enabled: boolean; hasUsers: boolean }>('/api/registration-status');

export async function fetchFolders(dev: DevFlags): Promise<Folder[]> {
  if (dev.simulateOffline) throw new ApiError(0, 'offline');
  if (dev.emptyChats) return [];
  return foldersApi.list();
}

export async function fetchSuggestions(dev: DevFlags): Promise<Suggestion[]> {
  await base(dev, 200);
  if (dev.emptySuggestions) return [];
  const items = await request<Suggestion[]>('/api/suggestions');
  /* the dev flag simulates a rate-limited serpapi provider for the status bar */
  return dev.rateLimited ? items.slice(0, 4) : items;
}

export async function fetchProviderHealth(dev: DevFlags): Promise<{
  providers: Provider[];
  latencyMs: number;
}> {
  if (dev.simulateOffline) throw new ApiError(0, 'offline');
  const res = await request<{ providers: Provider[]; latencyMs: number }>(
    '/api/provider-health',
  );
  const providers = res.providers.map((p) =>
    dev.rateLimited && p.status === 'ok'
      ? { ...p, status: 'rate_limited' as const, resetInSec: 42 }
      : p,
  );
  return { providers, latencyMs: dev.degraded ? 820 : res.latencyMs };
}

export type OutgoingMessage = {
  role: 'user';
  content: string;
  attachments: unknown[];
  modelId: string;
  thinkingLevel: string;
  toolGrants: Record<string, boolean>;
  toolProviders: Record<string, string>;
  paramOverrides: Record<string, unknown>;
  paramScope: string;
  /* the reply this turn follows; null starts a root branch */
  parentId: string | null;
  /* a chat that doesn't exist yet is created with this prompt on its first send */
  systemPrompt?: string;
  /* prefix every history turn sent to the model with its [yyyy/mm/dd HH:mm] timestamp */
  timestamps?: boolean;
};

export type SendResult = {
  chat: ChatSummary;
  user: Message;
  assistant: Message;
};

/* a private-chat turn: role plus plain text content, sent whole to the server */
export type TransientTurn = { role: 'user' | 'assistant'; content: string };

export type TransientSendResult = { assistant: Message };

/** starts an unsaved reply; the whole conversation ships as `history` and the reply streams from `readTransientStream` */
export const sendTransientMessage = (
  payload: {
    modelId: string;
    thinkingLevel: string;
    history: TransientTurn[];
  },
  dev: DevFlags,
): Promise<TransientSendResult> => {
  if (dev.simulateOffline) throw new ApiError(0, 'Offline');
  if (dev.failSend || payload.history.at(-1)?.content.includes('[fail]')) {
    throw new ApiError(
      500,
      'POST /api/transient/messages → 500 upstream provider error (simulated)',
    );
  }
  return request<TransientSendResult>('/api/transient/messages', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
};

/** streams an in-memory private-chat reply; same frame contract as `readStream` */
export async function readTransientStream(
  messageId: string,
  offset: number,
  on: {
    delta: (text: string) => void;
    tool: (call: ToolCall) => void;
    thought: (thought: Thought) => void;
    thoughtDelta: (d: Pick<Thought, 'step' | 'at' | 'text'>) => void;
  },
  signal: AbortSignal,
): Promise<StreamEnd | null> {
  return readStream(
    `/api/transient/messages/${messageId}/stream`,
    offset,
    on,
    signal,
  );
}

/** cancels a live private-chat reply */
export const stopTransientMessage = (messageId: string) =>
  request<{ stopped: boolean }>(`/api/transient/messages/${messageId}/stop`, {
    method: 'POST',
  });

/** stores the turn and starts generation server-side; the reply is read with `readStream` */
export async function sendMessage(
  chatId: string,
  payload: OutgoingMessage,
  dev: DevFlags,
): Promise<SendResult> {
  if (dev.slowNetwork) await delay(1500);
  if (dev.simulateOffline) throw new ApiError(0, 'Offline');
  if (dev.failSend || payload.content.includes('[fail]')) {
    throw new ApiError(
      500,
      `POST /chats/${chatId}/messages → 500 upstream provider error (simulated)`,
    );
  }
  return request<SendResult>(`/api/chats/${chatId}/messages`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export type RegenerateResult = { chat: ChatSummary; assistant: Message };

/** answers reply `messageId`'s user turn again as a new sibling branch; read it with `readStream` */
export const regenerateMessage = (
  messageId: string,
  body: Pick<OutgoingMessage, 'modelId' | 'toolGrants' | 'toolProviders'>,
) =>
  request<RegenerateResult>(`/api/messages/${messageId}/regenerate`, {
    method: 'POST',
    body: JSON.stringify(body),
  });

/** reruns reply `messageId`'s failed call `callId` as a new sibling branch that carries on from there */
export const retryToolCall = (
  messageId: string,
  callId: string,
  body: Pick<OutgoingMessage, 'modelId' | 'toolGrants' | 'toolProviders'>,
) =>
  request<RegenerateResult>(`/api/messages/${messageId}/retry`, {
    method: 'POST',
    body: JSON.stringify({ callId, ...body }),
  });

export type StreamEnd = {
  status: MessageStatus;
  error?: string | undefined;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens?: number | undefined;
    reasoningTokens?: number | undefined;
    costUsd?: number | undefined;
  };
  latencyMs?: number;
  refusal?: string | undefined;
  annotations?: UrlCitation[] | undefined;
};

/**
 * reads an assistant reply's sse stream from `offset` characters on. resolves with the
 * final status, or null when the connection dropped first (the run keeps going server-side,
 * so the caller reconnects with the new offset).
 */
export async function readStream(
  pathOrMessageId: string,
  offset: number,
  on: {
    delta: (text: string) => void;
    tool: (call: ToolCall) => void;
    thought: (thought: Thought) => void;
    thoughtDelta: (d: Pick<Thought, 'step' | 'at' | 'text'>) => void;
  },
  signal: AbortSignal,
): Promise<StreamEnd | null> {
  const streamPath = pathOrMessageId.startsWith('/')
    ? pathOrMessageId
    : `/api/messages/${pathOrMessageId}/stream`;
  let res: Response;
  try {
    res = await fetch(`${streamPath}?offset=${offset}`, {
      headers: { accept: 'text/event-stream' },
      signal,
    });
  } catch (e) {
    if (signal.aborted) throw e;
    return null;
  }
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new ApiError(res.status, body?.error ?? `stream → ${res.status}`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buf += value;
      let sep = buf.indexOf('\n\n');
      while (sep >= 0) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        sep = buf.indexOf('\n\n');
        const event = /^event: (.*)$/m.exec(frame)?.[1];
        const data = /^data: (.*)$/m.exec(frame)?.[1];
        /* heartbeats are bare comment frames */
        if (!event || data === undefined) continue;
        if (event === 'delta')
          on.delta((JSON.parse(data) as { text: string }).text);
        if (event === 'tool')
          on.tool((JSON.parse(data) as { call: ToolCall }).call);
        if (event === 'thought')
          on.thought((JSON.parse(data) as { thought: Thought }).thought);
        if (event === 'thought-delta')
          on.thoughtDelta(
            JSON.parse(data) as Pick<Thought, 'step' | 'at' | 'text'>,
          );
        if (event === 'done') return JSON.parse(data) as StreamEnd;
      }
    }
  } catch (e) {
    if (signal.aborted) throw e;
    return null;
  } finally {
    void reader.cancel().catch(() => {});
  }
}

/** answers an ask_user call that reply `messageId` is waiting on */
export const answerToolCall = (
  messageId: string,
  callId: string,
  answers: Record<string, string>,
) =>
  request<{ ok: true }>(`/api/messages/${messageId}/answer`, {
    method: 'POST',
    body: JSON.stringify({ callId, answers }),
  });

/** removes reply or turn `messageId` and everything after it; resolves with the recounted chat */
export const deleteMessage = (messageId: string) =>
  request<ChatSummary>(`/api/messages/${messageId}`, { method: 'DELETE' });

export const stopMessage = (messageId: string) =>
  request<{ stopped: boolean }>(`/api/messages/${messageId}/stop`, {
    method: 'POST',
  });

/** asks the server to classify a chat; empty when no provider can do it */
export async function classifyChat(chatId: string): Promise<{
  category?: string;
  tags?: string[];
}> {
  return request<{ category?: string; tags?: string[] }>(
    `/api/chats/${chatId}/classify`,
    { method: 'POST' },
  );
}

/** uploads one attachment's bytes under its client-minted id */
export async function uploadAttachment(
  attachment: Attachment,
  file: File,
): Promise<Attachment> {
  const form = new FormData();
  form.set('id', attachment.id);
  form.set('file', file);
  const res = await fetch('/api/attachments', { method: 'POST', body: form });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new ApiError(res.status, body?.error ?? `upload → ${res.status}`);
  }
  return attachment;
}

/** renames a stored attachment's display name (and download filename) */
export const renameAttachment = (id: string, name: string) =>
  request<{ id: string; name: string }>(`/api/attachments/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });

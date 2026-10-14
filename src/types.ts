/*
 * types.ts — the shared DTO/domain vocabulary of the whole app.
 *
 * Business logic:
 * - This file is the client/server contract: src/server/* routes build
 *   these shapes, stores and components consume them, and the messages
 *   table persists them verbatim in jsonb columns — so editing a type
 *   here is a wire change (API payloads and stored rows), not a local
 *   refactor.
 * - Message tree: a chat is a tree of Messages linked by parentId
 *   (null = a chat's first prompt); siblings sharing a parent are
 *   branches. ChatDetail ships every message of every branch and
 *   leafId selects the path the UI renders.
 * - Message lifecycle: `status` is server-owned, and only assistant
 *   messages ever leave 'done' (streaming/stopped/error/interrupted).
 * - Run traces: ToolCall and Thought records carry `step` (agent-loop
 *   round) and `at` (reply length when they started) so the thread can
 *   interleave them inline; `content` stays the reply's text only.
 * - ToolCall.result is what went back to the model (truncated); `raw`
 *   is the pre-shaping upstream response, shown in the UI but never
 *   sent to the model.
 * - Usage & cost: MessageUsage.reasoningTokens is a subset of
 *   completionTokens, costUsd is provider-reported (bifrost sets it,
 *   plain openai does not); MessageUsageDetails and MessageRouting keep
 *   every extra upstream token/cost/routing datapoint per message.
 * - Models: Model.kind defaults to 'llm' (only llm models can chat),
 *   capabilities and thinkingLevels gate composer affordances, and
 *   connectionId + remoteId map a per-connection namespaced model id
 *   back to the id the upstream API knows it by.
 * - Providers: Compatibility enumerates the supported upstream API
 *   dialects; ProviderConnection is the client-safe view of a
 *   user-configured provider — hasApiKey only, the key itself never
 *   leaves the server.
 * - Three-state key inputs: apiKey on ProviderConnectionInput and
 *   ToolCredentialInput means undefined = keep the stored key,
 *   null = clear it.
 * - Tools: ToolPreferences holds per-tool maps (grants, providers,
 *   counts, concurrency) where a missing tool falls back to its
 *   default; Tool.confirm explains what enabling a tool consents to.
 * - Tool key policy: ToolProviderKey.env is only sent to admins and
 *   only when set server-side; SiteSettings.envKeyAccess
 *   ('all'/'admins'/'none') decides who may use env-defined keys.
 * - Per-turn choices: Draft carries tool grants/providers and param
 *   overrides bounded by ParamScope; user messages persist their
 *   toolGrants/toolProviders so reopening a chat restores the
 *   selection, and chat/system prompts stack down the Folder chain.
 * - Organization: Folders nest via parentId (null = top level);
 *   ChatSummary.pinnedAt floats a chat to the sidebar top, unset
 *   folderId means no folder.
 * - Publishing: PublicArtifact is a frozen version behind a public
 *   link; chatId/leafId point back to the source chat and branch tip
 *   while they exist, and chatTitle is omitted once the chat is gone.
 * - Decisions: a DecisionRun evaluates `questions` against `input` with
 *   a decision model; each answer is a probability (predicate), one of
 *   the supplied choices, or a weighted level index (score), plus the
 *   distribution and confidence the provider reported. Re-running
 *   replaces the run's answers, so a row is its latest attempt only.
 */
import type { ArtifactKind } from './lib/artifacts';

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';
export type ToolId = string;
export type ProviderId = string;
export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
export type ParamScope = 'message' | 'chat' | 'global';
export type ConnStatus = 'connected' | 'degraded' | 'offline';

export type Draft = {
  text: string;
  attachments: Attachment[];
  modelId: string;
  thinkingLevel: ThinkingLevel;
  toolGrants: Record<ToolId, boolean>;
  toolProviders: Record<ToolId, ProviderId>;
  paramOverrides: Record<string, unknown>;
  paramScope: ParamScope;
};

export type HomeState = {
  draft: Draft;
  models: {
    items: Model[];
    status: LoadStatus;
    lastSyncedAt: number | null;
  };
  chats: { items: ChatSummary[]; status: LoadStatus; filter: string };
  suggestions: Suggestion[];
  banners: Banner[];
  layout: {
    sidebarWidth: number;
    sidebarCollapsed: boolean;
    rightPanel: 'closed' | 'context' | 'artifact';
  };
};

/* what the model is for; only llm models can chat, decision models answer
   OpenAI-style /decisions runs and systemone models answer /systemone runs */
export type ModelKind = 'llm' | 'embedding' | 'decision' | 'systemone';

/* which decision API a run was evaluated through: the OpenAI-style /decisions
   endpoint or the native TypeSafe System One /systemone endpoint */
export type DecisionKind = 'decision' | 'systemone';

/* upstream metadata surfaced in settings; only local runtimes report it */
export type ModelMeta = {
  architecture?: string | undefined;
  quantization?: string | undefined;
  format?: string | undefined;
  sizeBytes?: number | undefined;
  variants?: string[] | undefined;
  selectedVariant?: string | undefined;
};

export type Model = {
  id: string;
  shortName: string;
  provider: ProviderId;
  /* defaults to llm for backends that don't distinguish */
  kind?: ModelKind | undefined;
  capabilities: {
    thinking: boolean;
    vision: boolean;
    tools: boolean;
    audio: boolean;
    json: boolean;
    fast: boolean;
    /* a decision-capable model answers /decisions or /systemone; llm models
       behind a provider that serves /decisions (openai, bifrost, …) carry
       it too, so the composer can badge a chat model that also decides */
    decisions: boolean;
  };
  thinkingLevels?: ThinkingLevel[] | undefined;
  /* the model's own default reasoning setting, if it reports one */
  defaultThinkingLevel?: ThinkingLevel | undefined;
  meta?: ModelMeta | undefined;
  /* window is null when the provider doesn't report it */
  context: { window: number | null; maxOutput: number };
  /* parameter count as reported by local runtimes, e.g. "8B"; hosted apis don't expose it */
  params?: string | undefined;
  pricing: {
    input: number;
    cachedInput: number;
    output: number;
    reasoning?: number | undefined;
  };
  status: 'ok' | 'stale' | 'error';
  /* set for models served by a user-configured API provider */
  connectionId?: number | undefined;
  /* the id the upstream API knows the model by (`id` is namespaced per connection) */
  remoteId?: string | undefined;
};

export type Compatibility =
  | 'openai'
  | 'openrouter'
  | 'lmstudio'
  | 'ollama'
  | 'bifrost';

/** a user-configured API provider; the api key never leaves the server */
export type ProviderConnection = {
  id: number;
  name: string;
  baseUrl: string;
  compatibility: Compatibility;
  hasApiKey: boolean;
  /* disabled providers keep their config but drop out of the model list */
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ProviderConnectionInput = {
  name: string;
  baseUrl: string;
  compatibility: Compatibility;
  /* undefined keeps the stored key, null clears it */
  apiKey?: string | null | undefined;
};

export type ChatSummary = {
  id: string;
  title: string;
  modelId: string;
  branchCount: number;
  messageCount: number;
  costUsd: number;
  category?: string | undefined;
  tags: string[];
  /* unset = not in any folder */
  folderId?: string | undefined;
  /* unset = not pinned; pinned chats float to the top of the sidebar */
  pinnedAt?: number | undefined;
  /* stacked after the folder chain's prompts when generating */
  systemPrompt?: string | undefined;
  firstPrompt: string;
  createdAt: number;
  updatedAt: number;
};

/** folders nest through parentId; null sits at the top level */
export type Folder = {
  id: string;
  name: string;
  parentId: string | null;
  /* inherited by every chat and subfolder inside */
  systemPrompt?: string | undefined;
  createdAt: number;
};

export type Suggestion = {
  id: string;
  label: string;
  icon?: string | undefined;
  prompt: string;
  source: 'pinned' | 'recent' | 'static';
};

export type Attachment = {
  id: string;
  kind: 'file' | 'image' | 'note' | 'url' | 'memory' | 'chat';
  name: string;
  bytes?: number | undefined;
  mime?: string | undefined;
  noteId?: string | undefined;
  /* memory attachment: the memories row's id */
  memoryId?: string | undefined;
  /* chat attachment: the other chat's id whose transcript is inlined */
  chatId?: string | undefined;
  url?: string | undefined;
  scope?: 'message' | 'chat' | undefined;
};

export type Banner = {
  id: string;
  level: 'info' | 'warn' | 'error';
  text: string;
  actions?: { label: string; kind: string }[] | undefined;
};

export type Tool = {
  id: ToolId;
  label: string;
  description: string;
  requiresCapability?: keyof Model['capabilities'] | undefined;
  providers?: ProviderId[] | undefined;
  /* turning it on needs an explicit ok; the text explains what the user is agreeing to */
  confirm?: string | undefined;
};

/** saved per-tool choices; a tool missing from a map falls back to its default */
export type ToolPreferences = {
  grants: Record<ToolId, boolean>;
  providers: Record<ToolId, ProviderId>;
  /* per-tool integer settings keyed by tool id (e.g. web_search result count) */
  counts: Record<ToolId, number>;
  /* per-tool concurrency caps keyed by tool id (web_search, http_fetch; default 5) */
  concurrency: Record<ToolId, number>;
};

/** a user's own API token for a tool provider; the secret never leaves the server */
export type ToolCredential = {
  provider: string;
  hasApiKey: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ToolCredentialInput = {
  provider: string;
  /* undefined keeps the stored key, null clears it */
  apiKey?: string | null | undefined;
};

/** a tool key provider as offered in settings, plus what the environment already covers */
export type ToolProviderKey = {
  id: string;
  label: string;
  /* env var name; only sent to admins, and only when it is set on the server */
  env?: string | undefined;
  /* true when the env-defined key is usable by the asking user under the site policy */
  envShared?: boolean | undefined;
};

export type Provider = {
  id: ProviderId;
  label: string;
  status: 'ok' | 'rate_limited' | 'error';
  resetInSec?: number | undefined;
};

/* a cross-chat fact saved by the memory tool or edited in settings */
export type Memory = {
  id: string;
  key: string;
  value: string;
  createdAt: number;
  updatedAt: number;
};

export type Note = {
  id: string;
  title: string;
  text: string;
  createdAt: number;
  updatedAt: number;
};

/* what a decision question asks for; `refusal` only ever arrives on an answer */
export type DecisionQuestionType = 'predicate' | 'choice' | 'score';

export type DecisionChoice = {
  value: string;
  description?: string | undefined;
};

export type DecisionLevel = {
  label: string;
  description?: string | undefined;
};

/** one question of a decision run; `name` is the identifier its answer comes back under */
export type DecisionQuestion = {
  name: string;
  type: DecisionQuestionType;
  instructions: string;
  /* predicate only: what the two outcomes mean; typesafe-backed models read it */
  criteria?:
    | { true?: string | undefined; false?: string | undefined }
    | undefined;
  /* choice only: the selectable values */
  choices?: DecisionChoice[] | undefined;
  /* score only: the ordered levels, lowest first */
  levels?: DecisionLevel[] | undefined;
};

/** one point of an answer's distribution: a choice value or a level index */
export type DecisionProbability = {
  value: string | number;
  /* score answers: the level's label */
  label?: string | undefined;
  probability: number;
};

export type DecisionAnswer = {
  name: string;
  /* the question's type, or `refusal` when the model declined to answer */
  type: DecisionQuestionType | 'refusal';
  /* predicate: estimate in [0,1] that the condition is true */
  probability?: number | undefined;
  /* choice: the selected value */
  choice?: string | undefined;
  /* score: probability-weighted level index, so it can fall between levels */
  score?: number | undefined;
  /* choice/score: the distribution over values or levels */
  probabilities?: DecisionProbability[] | undefined;
  confidence?: number | undefined;
  /* score: level index → label, when the provider reports one */
  legend?: Record<string, string> | undefined;
};

/** one decision run: the questions, the evidence they were asked about, and the answers */
export type DecisionRun = {
  id: string;
  /* which endpoint the run was evaluated through — OpenAI /decisions or System One /systemone */
  kind: DecisionKind;
  title: string;
  /* namespaced `connectionId:remoteId` model id the run was evaluated with */
  modelId: string;
  input: string;
  questions: DecisionQuestion[];
  /* absent until an evaluation succeeded; a run keeps only its latest attempt */
  answers?: DecisionAnswer[] | undefined;
  /* the last attempt's upstream failure, kept beside the questions that caused it */
  error?: string | undefined;
  usage?: MessageUsage | undefined;
  latencyMs?: number | undefined;
  createdAt: number;
  updatedAt: number;
};

/** a frozen artifact version published to a public link */
export type PublicArtifact = {
  /** the row's integer id, and the <id> in its /a/<id> share url */
  id: number;
  /* the artifact tool's in-branch id, e.g. "todo-app" */
  artifactId: string;
  title: string;
  kind: ArtifactKind;
  language?: string | undefined;
  content: string;
  version: number;
  published: boolean;
  /* source chat/branch, when it still exists */
  chatId?: string | undefined;
  /** the chat's title at read time; omitted once the chat is gone */
  chatTitle?: string | undefined;
  /* branch tip at publish time, for reopening the exact version */
  leafId?: string | undefined;
  createdAt: number;
  updatedAt: number;
};

/* server-side lifecycle; only assistant messages ever leave 'done' */
export type MessageStatus =
  | 'done'
  | 'streaming'
  | 'stopped'
  | 'error'
  | 'interrupted';

export type MessageUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number | undefined;
  /* output tokens spent on reasoning, a subset of completionTokens */
  reasoningTokens?: number | undefined;
  /* provider-reported cost in usd; bifrost sets it, plain openai does not */
  costUsd?: number | undefined;
};

/* every extra upstream token/cost datapoint we could capture, kept per message */
export type MessageUsageDetails = {
  /* prompt token split reported as `prompt_tokens_details` */
  promptDetails?: {
    audioTokens?: number | undefined;
    imageTokens?: number | undefined;
    cachedReadTokens?: number | undefined;
    cachedWriteTokens?: number | undefined;
  } | undefined;
  /* completion token split reported as `completion_tokens_details` */
  completionDetails?: {
    audioTokens?: number | undefined;
    reasoningTokens?: number | undefined;
    acceptedPredictionTokens?: number | undefined;
    rejectedPredictionTokens?: number | undefined;
    citationTokens?: number | undefined;
    imageTokens?: number | undefined;
    searchQueries?: number | undefined;
  } | undefined;
  /* the full provider-reported cost breakdown (bifrost `usage.cost`) */
  cost?: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    reasoningTokens?: number | undefined;
    citationTokens?: number | undefined;
    searchQueries?: number | undefined;
    request?: number | undefined;
    total?: number | undefined;
  } | undefined;
};

/* upstream routing/identity fields surfaced per assistant message where available */
export type MessageRouting = {
  /* bifrost `extra_fields` */
  provider?: string | undefined;
  modelRequested?: string | undefined;
  modelDeployment?: string | undefined;
  latencyMs?: number | undefined;
  /* openrouter routing metadata */
  routeProvider?: string | undefined;
  strategy?: string | undefined;
};

export type Message = {
  id: string;
  /* the turn this one answers or follows; null for a chat's first prompt. siblings are branches */
  parentId: string | null;
  role: 'user' | 'assistant';
  content: string;
  attachments: Attachment[];
  modelId?: string | undefined;
  status: MessageStatus;
  error?: string | undefined;
  /* user only: the tools granted for this turn, so reopening the chat restores the selection */
  toolGrants?: Record<ToolId, boolean> | undefined;
  toolProviders?: Record<ToolId, ProviderId> | undefined;
  /* assistant only: function calls made while writing the reply */
  toolCalls?: ToolCall[] | undefined;
  /* assistant only: reasoning the model streamed, one block per agent-loop step */
  thoughts?: Thought[] | undefined;
  /* assistant only: the model declined the request instead of answering */
  refusal?: string | undefined;
  /* assistant only: web-search sources cited in the reply */
  annotations?: UrlCitation[] | undefined;
  /* assistant only: token/cost details beyond the summary `usage` */
  usageDetails?: MessageUsageDetails | undefined;
  /* assistant only: upstream routing/identity data (bifrost extra_fields, openrouter metadata) */
  routing?: MessageRouting | undefined;
  /*
   * TODO(audio): audio output is not implemented. when `modalities: ['audio']` is
   * supported, surface the completion's `message.audio`: `transcript` (text of the
   * spoken reply) and `data` (base64 audio bytes, playable once decoded).
   */
  /* set once generation completes; token counts from the provider API */
  usage?: MessageUsage | undefined;
  /* server-side wall-clock ms from request to final response */
  latencyMs?: number | undefined;
  createdAt: number;
};

/** one web-search source the model cited; offsets index into the reply's content */
export type UrlCitation = {
  url: string;
  title: string;
  startIndex: number;
  endIndex: number;
};

/** reasoning text from one model round-trip; kept out of `content` and never replayed */
export type Thought = {
  /* agent-loop step, same numbering as ToolCall.step */
  step: number;
  /* reply text length when it started, so the thread can render it inline */
  at: number;
  text: string;
  /* set once the model moves on to answering or calling tools */
  ms?: number | undefined;
};

/** one function call the model made mid-reply; `content` stays the reply's text only */
export type ToolCall = {
  id: string;
  name: ToolId;
  /* json arguments exactly as the model sent them */
  args: string;
  status: 'running' | 'done' | 'error';
  /* what went back to the model (truncated), or the error text */
  result?: string | undefined;
  /* the upstream response before the tool reshaped it; shown in the ui, never sent to the model */
  raw?: string | undefined;
  ms?: number | undefined;
  /* reply text length when the call was made, so the thread can render it inline */
  at: number;
  /* agent-loop step; calls sharing a step were requested together */
  step: number;
};

/** server-side readiness of a tool, from GET /api/tools */
export type ToolStatus = {
  id: ToolId;
  available: boolean;
  reason?: string | undefined;
  /* backends with credentials configured, for tools that offer a choice */
  providers?: ProviderId[] | undefined;
};

/** every message across all branches; `leafId` picks the branch on screen */
export type ChatDetail = {
  chat: ChatSummary;
  messages: Message[];
  leafId: string | null;
};

export type Toast = {
  id: string;
  text: string;
  level: 'info' | 'warn' | 'error';
};

export type Prefs = {
  theme: 'light' | 'dark' | 'system';
  enterToSend: boolean;
  spellcheck: boolean;
};

/**
 * who may use environment-defined tool api keys. `all` exposes them to every user,
 * `admins` (the default) to admins only, and `none` to nobody — each user must then
 * bring their own key.
 */
export type EnvKeyAccess = 'all' | 'admins' | 'none';

/** site-wide settings, stored in the database and managed by admins */
export type SiteSettings = {
  registrationEnabled: boolean;
  /* who the env-defined tool keys (TAVILY_API_KEY, …) are shared with */
  envKeyAccess: EnvKeyAccess;
};

/** a user account as listed and managed by admins */
export type AdminUser = {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
  createdAt: number;
  updatedAt: number;
};

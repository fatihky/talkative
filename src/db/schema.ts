/*
 * schema — the whole Postgres schema (Drizzle) and its business rules.
 *
 * Business logic:
 * - Ownership: nearly every content table carries a userId FK to user
 *   with ON DELETE CASCADE, so deleting a user erases their chats,
 *   messages, folders, notes, memories, todos, attachments, artifacts,
 *   decisions, provider connections, tool credentials/preferences, and
 *   better-auth's session/account rows. user/session/account/verification follow
 *   better-auth's own shape.
 * - messages is a tree, not a list: parentId is a soft self-reference (no
 *   FK), chats.leafId points at the active branch tip, and chats.branchCount
 *   counts tips for the header badge. role is user|assistant; the status
 *   enum (done|streaming|stopped|error|interrupted) tracks a reply's
 *   lifecycle and defaults to done.
 * - jsonb payloads carry a turn's shape: messages.attachments, toolCalls,
 *   thoughts and annotations default to []; toolGrants/toolProviders
 *   (per-message tool permissions carried on the user turn) and
 *   usage/usageDetails/routing stay null until set.
 * - Soft references on purpose: messages.attachments holds attachment ids
 *   with no FK and no cascade — an edit or resend reuses ids across
 *   branches, so only app code (pruneAttachments) may decide a file is
 *   truly orphaned. attachments.id is a client-minted PK and data is a
 *   nullable bytea: text files inline their bytes, images live on the
 *   filesystem so their row keeps only metadata (data null).
 * - Encrypted secrets: provider_connections.api_key and
 *   tool_credentials.api_key hold plaintext or an enc:<version>:<base64>
 *   envelope (secrets.ts); neither column may be trusted as-is nor sent
 *   upstream raw. A user's tool credential always wins over an
 *   environment-defined key for the same provider.
 * - Enums/defaults that encode policy: compatibilityEnum
 *   (openai|openrouter|lmstudio|ollama|bifrost) picks a catalog fetcher;
 *   user.isAdmin defaults false (the app promotes the first registrant);
 *   providerConnections.enabled defaults true; chats.branchCount defaults
 *   1; artifacts.published defaults false and version defaults 1.
 * - artifacts freezes a published version: chatId/messageId/callId/leafId
 *   are loose text (chatId has no FK), so editing or deleting the source
 *   chat never drops or mutates the published artifact a public link still
 *   renders. Its id is an integer identity column (like
 *   providerConnections) and doubles as the /a/<id> share url — there is
 *   no slug column beside it.
 * - folders nest through a soft parentId self-reference; a folder's
 *   systemPrompt is inherited by its chats, and chat.systemPrompt stacks on
 *   top of the folder chain when generating.
 * - model_overrides layers a user's corrections over a provider's catalog
 *   (capabilities, context, pricing, custom models, hidden models); a row
 *   with connection_id is a model the provider never listed, addressed by
 *   remote_id through that connection.
 * - Indexes back the hot query paths: chats (userId,updatedAt) and
 *   (userId,createdAt) for the sidebar; messages chatId and parentId for
 *   tree loads; todos chatId and (chatId,done); notes/artifacts/decisions
 *   (userId,createdAt); attachments and providerConnections userId;
 *   memories unique (userId,key); toolPreferences/toolCredentials use
 *   composite PKs (userId,toolId) / (userId,provider).
 * - Search runs on expression indexes, not stored columns, so whole-row
 *   selects stay as lean as before: GIN over messageSearchDoc (content) and
 *   messageExtraDoc (thought text plus tool-call args/results), both on the
 *   'simple' config (chats mix languages and code, stemming mangles
 *   identifiers) and capped at SEARCH_DOC_CHARS so a huge paste can't hit
 *   the 1MB tsvector limit and fail its insert; pg_trgm GIN indexes on
 *   messages.content and chats.title keep substring (ILIKE) matching fast.
 *   Queries must build the doc with these same helpers or the planner
 *   won't match the index.
 * - app_settings is a key/value store (key PK, jsonb value), one row per
 *   settings key; todos are volatile chat-scoped working memory that
 *   cascades away with their chat.
 */
import { type AnyColumn, relations, type SQL, sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  decimal,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/* text past this point is left out of the search docs; keeps a tsvector well under its 1MB cap */
export const SEARCH_DOC_CHARS = 100_000;

/** a message's searchable text as a tsvector; must match messages_search_idx exactly */
export const messageSearchDoc = (content: AnyColumn | SQL): SQL =>
  sql`to_tsvector('simple'::regconfig, left(${content}, ${sql.raw(String(SEARCH_DOC_CHARS))}))`;

/** reasoning text plus tool-call args and results, flattened from their jsonb (escapes blanked) */
export const messageExtraText = (
  thoughts: AnyColumn | SQL,
  toolCalls: AnyColumn | SQL,
): SQL =>
  sql`left(regexp_replace((jsonb_path_query_array(${thoughts}, '$[*].text') || jsonb_path_query_array(${toolCalls}, '$[*].args') || jsonb_path_query_array(${toolCalls}, '$[*].result'))::text, '\\\\[nrt]', ' ', 'g'), ${sql.raw(String(SEARCH_DOC_CHARS))})`;

/** messageExtraText as a tsvector; must match messages_search_extra_idx exactly */
export const messageExtraDoc = (
  thoughts: AnyColumn | SQL,
  toolCalls: AnyColumn | SQL,
): SQL =>
  sql`to_tsvector('simple'::regconfig, ${messageExtraText(thoughts, toolCalls)})`;

/* postgres bytea; drizzle has no first-party column for it. nullable: images are
   stored on the filesystem, so their row keeps only metadata and a null `data`. */
const bytea = customType<{
  data: Buffer | null;
  notNull: false;
  default: false;
}>({
  dataType: () => 'bytea',
});

/* llm provider compatibility modes; each maps to a catalog fetcher */
export const compatibilityEnum = pgEnum('compatibility', [
  'openai',
  'openrouter',
  'lmstudio',
  'ollama',
  'bifrost',
]);

/* which decision API a run used: OpenAI-style /decisions or native /systemone */
export const decisionKindEnum = pgEnum('decision_kind', [
  'decision',
  'systemone',
]);

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').default(false).notNull(),
  image: text('image'),
  /* the first registered user is made admin automatically */
  isAdmin: boolean('is_admin').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export type UserRow = typeof user.$inferSelect;
export type NewUser = typeof user.$inferInsert;

/* key/value store for site-wide settings; each row holds one settings key */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: timestamp('updated_at')
    .defaultNow()
    .$onUpdate(() => /* @__PURE__ */ new Date())
    .notNull(),
});

export type AppSettingRow = typeof appSettings.$inferSelect;
export type NewAppSetting = typeof appSettings.$inferInsert;

export const session = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expires_at').notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
  },
  (table) => [index('session_userId_idx').on(table.userId)],
);

export const account = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('account_userId_idx').on(table.userId)],
);

export const verification = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
);

export const providerConnections = pgTable(
  'provider_connections',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    baseUrl: text('base_url').notNull(),
    compatibility: compatibilityEnum('compatibility').notNull(),
    apiKey: text('api_key'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [index('provider_connections_user_id_idx').on(table.userId)],
);

export type ProviderConnectionRow = typeof providerConnections.$inferSelect;
export type NewProviderConnection = typeof providerConnections.$inferInsert;

/*
 * a user's correction to one model (server/model-overrides.ts). model_id is
 * either a catalog id (${connectionId}:${remoteId}) or, for a user-added model,
 * an id that deliberately doesn't parse; every other column is an override and
 * null means "keep what the provider reports". connection_id, remote_id and
 * base_url are only set on custom models: a run reaches the connection by that
 * id, sends remote_id as the upstream model name, and may swap the connection's
 * url for base_url. Deleting a connection drops the rows pointing at it.
 */
export const modelOverrides = pgTable(
  'model_overrides',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    modelId: text('model_id').notNull(),
    shortName: text('short_name'),
    kind: text('kind'),
    contextWindow: integer('context_window'),
    maxOutput: integer('max_output'),
    thinkingLevels: jsonb('thinking_levels').$type<string[]>(),
    defaultThinkingLevel: text('default_thinking_level'),
    capabilities: jsonb('capabilities').$type<Record<string, boolean>>(),
    /* USD per 1M tokens, like Model.pricing */
    pricing: jsonb('pricing').$type<Record<string, number>>(),
    params: text('params'),
    hidden: boolean('hidden').notNull().default(false),
    connectionId: integer('connection_id').references(
      () => providerConnections.id,
      { onDelete: 'cascade' },
    ),
    remoteId: text('remote_id'),
    baseUrl: text('base_url'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.modelId] }),
    index('model_overrides_connection_id_idx').on(table.connectionId),
  ],
);

export type ModelOverrideRow = typeof modelOverrides.$inferSelect;
export type NewModelOverride = typeof modelOverrides.$inferInsert;

/* folders nest through parent_id; a folder's system prompt is inherited by its chats */
export const folders = pgTable(
  'folders',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    parentId: text('parent_id'),
    systemPrompt: text('system_prompt'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index('folders_user_id_idx').on(table.userId),
    index('folders_parent_id_idx').on(table.parentId),
  ],
);

export type FolderRow = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;

/* chat enums */
export const roleEnum = pgEnum('message_role', ['user', 'assistant']);
export const messageStatusEnum = pgEnum('message_status', [
  'done',
  'streaming',
  'stopped',
  'error',
  'interrupted',
]);

export const chats = pgTable(
  'chats',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    firstPrompt: text('first_prompt').notNull().default(''),
    modelId: text('model_id').notNull(),
    leafId: text('leaf_id'),
    messageCount: integer('message_count').notNull().default(0),
    /* number of tips in the message tree; shown as the header's branch counter */
    branchCount: integer('branch_count').notNull().default(1),
    /* total spend across the chat's replies, in usd */
    costUsd: decimal('cost_usd', { precision: 12, scale: 6 })
      .notNull()
      .default('0'),
    /* ai classification, shown as a filter chip */
    category: text('category'),
    tags: text('tags').array().notNull().default([]),
    /* stacked after the folder chain's prompts when generating */
    systemPrompt: text('system_prompt'),
    /* the folder this chat sits in; null at the top level */
    folderId: text('folder_id').references(() => folders.id, {
      onDelete: 'set null',
    }),
    /* pinned chats float to the top of the sidebar; null means not pinned */
    pinnedAt: timestamp('pinned_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index('chats_user_id_updated_at_idx').on(table.userId, table.updatedAt),
    index('chats_user_id_created_at_idx').on(table.userId, table.createdAt),
    index('chats_folder_id_idx').on(table.folderId),
    index('chats_title_trgm_idx').using('gin', table.title.op('gin_trgm_ops')),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    parentId: text('parent_id'),
    role: roleEnum('role').notNull(),
    content: text('content').notNull().default(''),
    attachments: jsonb('attachments').notNull().default([]),
    toolCalls: jsonb('tool_calls').notNull().default([]),
    thoughts: jsonb('thoughts').notNull().default([]),
    /* assistant only: refusal text and web-search citations, both parsed from the completion */
    refusal: text('refusal'),
    annotations: jsonb('annotations').notNull().default([]),
    /* per-message tool permissions, carried on the user turn so a queued run keeps them */
    toolGrants: jsonb('tool_grants'),
    toolProviders: jsonb('tool_providers'),
    /* user only: this send prefixed every history turn with its [yyyy/mm/dd HH:mm] timestamp */
    timestampPrefix: boolean('timestamp_prefix').notNull().default(false),
    modelId: text('model_id'),
    status: messageStatusEnum('status').notNull().default('done'),
    error: text('error'),
    usage: jsonb('usage'),
    /* assistant only: token/cost details and routing extras beyond the summary `usage` */
    usageDetails: jsonb('usage_details'),
    routing: jsonb('routing'),
    latencyMs: integer('latency_ms'),
    /* set on a user turn waiting behind an active run; cleared when it starts or is removed */
    queuedAt: timestamp('queued_at'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index('messages_chat_id_idx').on(table.chatId),
    index('messages_parent_id_idx').on(table.parentId),
    index('messages_search_idx').using('gin', messageSearchDoc(table.content)),
    index('messages_search_extra_idx').using(
      'gin',
      messageExtraDoc(table.thoughts, table.toolCalls),
    ),
    index('messages_content_trgm_idx').using(
      'gin',
      table.content.op('gin_trgm_ops'),
    ),
  ],
);

export type ChatRow = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export const memories = pgTable(
  'memories',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('memories_user_id_key_unique').on(table.userId, table.key),
  ],
);

export type MemoryRow = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;

/* scratch todos managed by the todo tool; one row per item, scoped to a chat.
   the list is volatile working memory the model uses while generating, so a chat
   being deleted takes its todos with it. */
export const todos = pgTable(
  'todos',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    note: text('note'),
    done: boolean('done').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index('todos_chat_id_idx').on(table.chatId),
    index('todos_chat_id_done_idx').on(table.chatId, table.done),
  ],
);

export type TodoRow = typeof todos.$inferSelect;
export type NewTodo = typeof todos.$inferInsert;

/* user notes, attachable to a turn and editable in the notes screen */
export const notes = pgTable(
  'notes',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    text: text('text').notNull().default(''),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index('notes_user_id_created_at_idx').on(table.userId, table.createdAt),
  ],
);

export type NoteRow = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;

/* uploaded file/image bytes, keyed by the client-minted attachment id. text files are
   inlined into the prompt, so their bytes live in `data`; images are sent as vision
   inputs and stored on the filesystem, so their row keeps only metadata (null data). */
export const attachments = pgTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    mime: text('mime').notNull().default('application/octet-stream'),
    bytes: integer('bytes').notNull(),
    data: bytea('data'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (table) => [index('attachments_user_id_idx').on(table.userId)],
);

export type AttachmentRow = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;

/* only tools the user has touched have a row; the client fills the rest from defaults */
export const toolPreferences = pgTable(
  'tool_preferences',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    toolId: text('tool_id').notNull(),
    enabled: boolean('enabled').notNull(),
    provider: text('provider'),
    /* per-tool scalar preferences; web_search uses it as the result count */
    resultCount: integer('result_count'),
    /* per-tool concurrency cap; web_search and http_fetch use it independently */
    concurrency: integer('concurrency'),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.toolId] })],
);

export type ToolPreferenceRow = typeof toolPreferences.$inferSelect;
export type NewToolPreference = typeof toolPreferences.$inferInsert;

/* a user's own API token for a tool provider (tavily, scrape.do, github, …).
   the secret is sealed with the same encryption as provider_connections.api_key,
   and always wins over an environment-defined key for the same provider. */
export const toolCredentials = pgTable(
  'tool_credentials',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    apiKey: text('api_key'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.provider] })],
);

export type ToolCredentialRow = typeof toolCredentials.$inferSelect;
export type NewToolCredential = typeof toolCredentials.$inferInsert;

/*
 * a published artifact. artifacts themselves are derived on demand from a branch's
 * tool-call `raw`; publishing freezes one version here so a public link keeps rendering
 * even as the chat is edited or the branch is deleted. the integer id is also the
 * /a/<id> share url — there is no separate slug.
 */
export const artifacts = pgTable(
  'artifacts',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /* where it came from; kept loose so deleting the source chat doesn't drop the artifact */
    chatId: text('chat_id'),
    messageId: text('message_id'),
    callId: text('call_id'),
    /* the branch tip at publish time, so the owner can reopen the exact version */
    leafId: text('leaf_id'),
    /* the artifact tool's in-branch id, e.g. "todo-app" */
    artifactId: text('artifact_id').notNull(),
    title: text('title').notNull(),
    kind: text('kind').notNull(),
    language: text('language'),
    content: text('content').notNull(),
    version: integer('version').notNull().default(1),
    published: boolean('published').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index('artifacts_user_id_created_at_idx').on(table.userId, table.createdAt),
    index('artifacts_chat_id_idx').on(table.chatId),
  ],
);

export type ArtifactRow = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;

/*
 * one decision run: the input and questions that were evaluated, and the answers that
 * came back. re-running POSTs the same id, so a row holds the latest attempt only —
 * the history is the list of runs, not a list of attempts. `answers` stays null until
 * an evaluation succeeded; a failed one records its upstream `error` beside the
 * questions it was asked with.
 */
export const decisions = pgTable(
  'decisions',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /* which decision API the run was evaluated through; defaults to the OpenAI-style endpoint */
    kind: decisionKindEnum('kind').notNull().default('decision'),
    /* the namespaced `connectionId:remoteId` model id the run was evaluated with */
    modelId: text('model_id').notNull(),
    title: text('title').notNull().default(''),
    input: text('input').notNull().default(''),
    questions: jsonb('questions').notNull().default([]),
    answers: jsonb('answers'),
    error: text('error'),
    usage: jsonb('usage'),
    latencyMs: integer('latency_ms'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at')
      .defaultNow()
      .$onUpdate(() => /* @__PURE__ */ new Date())
      .notNull(),
  },
  (table) => [
    index('decisions_user_id_created_at_idx').on(table.userId, table.createdAt),
  ],
);

export type DecisionRow = typeof decisions.$inferSelect;
export type NewDecision = typeof decisions.$inferInsert;

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  providerConnections: many(providerConnections),
  toolCredentials: many(toolCredentials),
  folders: many(folders),
  chats: many(chats),
  notes: many(notes),
  memories: many(memories),
  todos: many(todos),
  attachments: many(attachments),
  artifacts: many(artifacts),
  decisions: many(decisions),
}));

export const chatRelations = relations(chats, ({ one, many }) => ({
  user: one(user, {
    fields: [chats.userId],
    references: [user.id],
  }),
  folder: one(folders, {
    fields: [chats.folderId],
    references: [folders.id],
  }),
  messages: many(messages),
}));

export const messageRelations = relations(messages, ({ one }) => ({
  chat: one(chats, {
    fields: [messages.chatId],
    references: [chats.id],
  }),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));

export const providerConnectionRelations = relations(
  providerConnections,
  ({ one }) => ({
    user: one(user, {
      fields: [providerConnections.userId],
      references: [user.id],
    }),
  }),
);

export const artifactRelations = relations(artifacts, ({ one }) => ({
  user: one(user, {
    fields: [artifacts.userId],
    references: [user.id],
  }),
}));

export const decisionRelations = relations(decisions, ({ one }) => ({
  user: one(user, {
    fields: [decisions.userId],
    references: [user.id],
  }),
}));

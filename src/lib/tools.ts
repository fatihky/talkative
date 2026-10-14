/*
 * tools — the one tool catalog: ids, UI copy, backends and default
 * preferences, shared by the client (grants ui) and the server (registry in
 * src/server/tools).
 *
 * Business logic:
 * - TOOLS is the contract both sides key off: the client renders the grants
 *   dropdown from it, the server validates saved preferences against it and
 *   reports one ToolStatus per entry — an id with no registered
 *   implementation comes back as "not implemented yet". Adding a tool means
 *   adding it here and registering an implementation.
 * - `providers` lists the backends a user may pick for that tool (the real
 *   search/fetch keys for web_search and http_fetch, `default`/`direct` for
 *   the built-ins), and `requiresCapability` is `tools` for all of them, so
 *   a model without tool support disables the whole set and its grants are
 *   left out of the send payload.
 * - `confirm` marks a grant that needs an explicit ok; chat_search is the
 *   only one, and its text is what the confirm dialog shows about the model
 *   reading the user's other chats.
 * - DEFAULT_GRANTS is the out-of-the-box permission matrix: local or
 *   key-less tools on (file_read, web_search, memory, todo, ask_user,
 *   artifact, get_current_timestamp), everything that executes code or
 *   reaches a third party off (code_exec, http_fetch, browser, db_query,
 *   image_gen, the github_* set, chat_search).
 * - DEFAULT_PROVIDERS gives each tool its initial backend (serpapi for
 *   web_search, direct for http_fetch, default elsewhere). Saved
 *   preferences and per-chat params are merged over these maps, so a tool
 *   added later still resolves to a default.
 * - DEFAULT_COUNTS (web_search returns 5 results) and DEFAULT_CONCURRENCIES
 *   (web_search and http_fetch may run 5 at once) are the per-tool
 *   tunables; the concurrency cap is applied per user for a user's own key
 *   and globally per provider when the shared environment key is in use.
 */
import type { Tool } from '../types';

/* shared by the client (grants ui) and the server (registry in src/server/tools) */
export const TOOLS: Tool[] = [
  {
    id: 'web_search',
    label: 'web_search',
    description: 'Search the live web',
    requiresCapability: 'tools',
    providers: [
      'serpapi',
      'serper.dev',
      'tavily',
      'searxng',
      'scrape.do',
      'exa',
    ],
  },
  {
    id: 'code_exec',
    label: 'code_exec',
    description: 'Run code in a sandbox',
    requiresCapability: 'tools',
    providers: ['default'],
  },
  {
    id: 'file_read',
    label: 'file_read',
    description: 'Read attached files',
    requiresCapability: 'tools',
    providers: ['default'],
  },
  {
    id: 'http_fetch',
    label: 'http_fetch',
    description: 'Fetch a URL',
    requiresCapability: 'tools',
    providers: ['direct', 'scrape.do', 'tavily'],
  },
  {
    id: 'browser',
    label: 'browser',
    description: 'Drive a headless browser',
    requiresCapability: 'tools',
    providers: ['default'],
  },
  {
    id: 'db_query',
    label: 'db_query',
    description: 'Query connected databases',
    requiresCapability: 'tools',
    providers: ['default'],
  },
  {
    id: 'image_gen',
    label: 'image_gen',
    description: 'Generate images',
    requiresCapability: 'tools',
    providers: ['default'],
  },
  {
    id: 'memory',
    label: 'memory',
    description: 'Persistent cross-chat memory',
    requiresCapability: 'tools',
    providers: ['default'],
  },
  {
    id: 'todo',
    label: 'todo',
    description: 'Manage a to-do list you can track across chats',
    requiresCapability: 'tools',
    providers: ['default'],
  },
  {
    id: 'artifact',
    label: 'artifact',
    description: 'Write code, documents and pages to the artifact panel',
    requiresCapability: 'tools',
    providers: ['default'],
  },
  {
    id: 'ask_user',
    label: 'ask_user',
    description: 'Ask you questions and wait for an answer',
    requiresCapability: 'tools',
    providers: ['default'],
  },
  {
    id: 'chat_search',
    label: 'chat_search',
    description: 'Search your other chats',
    requiresCapability: 'tools',
    providers: ['default'],
    confirm:
      'The model will be able to read titles and messages from all of your other chats, ' +
      'and whatever it finds is sent to the model provider of the chat it runs in.',
  },
  {
    id: 'github_repo_search',
    label: 'github_repo_search',
    description: 'Search GitHub repositories',
    requiresCapability: 'tools',
    providers: ['default'],
  },
  {
    id: 'github_file_fetch',
    label: 'github_file_fetch',
    description: 'Read a file from a GitHub repository',
    requiresCapability: 'tools',
    providers: ['default'],
  },
  {
    id: 'github_issue_search',
    label: 'github_issue_search',
    description: 'Search GitHub issues',
    requiresCapability: 'tools',
    providers: ['default'],
  },
  {
    id: 'github_pr_search',
    label: 'github_pr_search',
    description: 'Search GitHub pull requests',
    requiresCapability: 'tools',
    providers: ['default'],
  },
  {
    id: 'github_discussion_search',
    label: 'github_discussion_search',
    description: 'Search GitHub discussions',
    requiresCapability: 'tools',
    providers: ['default'],
  },
  {
    id: 'get_current_timestamp',
    label: 'get_current_timestamp',
    description: 'Get the current date and time',
    requiresCapability: 'tools',
    providers: ['default'],
  },
];

export const DEFAULT_GRANTS: Record<string, boolean> = {
  file_read: true,
  web_search: true,
  memory: true,
  todo: true,
  ask_user: true,
  artifact: true,
  chat_search: false,
  code_exec: false,
  http_fetch: false,
  browser: false,
  db_query: false,
  image_gen: false,
  github_repo_search: false,
  github_file_fetch: false,
  github_issue_search: false,
  github_pr_search: false,
  github_discussion_search: false,
  get_current_timestamp: true,
};
export const DEFAULT_PROVIDERS: Record<string, string> = {
  web_search: 'serpapi',
  code_exec: 'default',
  file_read: 'default',
  http_fetch: 'direct',
  browser: 'default',
  db_query: 'default',
  image_gen: 'default',
  memory: 'default',
  todo: 'default',
  ask_user: 'default',
  artifact: 'default',
  chat_search: 'default',
  github_repo_search: 'default',
  github_file_fetch: 'default',
  github_issue_search: 'default',
  github_pr_search: 'default',
  github_discussion_search: 'default',
  get_current_timestamp: 'default',
};
export const DEFAULT_COUNTS: Record<string, number> = {
  web_search: 5,
};
/* concurrent calls a tool may run at once per user (or globally, for a shared key) */
export const DEFAULT_CONCURRENCIES: Record<string, number> = {
  web_search: 5,
  http_fetch: 5,
};

/*
 * mock — the demo model catalog and the fixed UI fixtures from the UI port.
 *
 * Business logic:
 * - Not a test double: it ships in the client bundle and server code
 *   imports it too (suggestions).
 * - MODELS is what fetchModels serves when the server reports zero provider
 *   connections, so a fresh install still has a working model picker. The
 *   entries deliberately cover the states the UI has to handle: ok / stale /
 *   error status (error = no api key configured), thinking on and off, an
 *   absent thinkingLevels meaning "capability unknown", vision, audio, fast,
 *   a 1M context window, and reasoning-priced output.
 * - PINNED_SUGGESTIONS and STATIC_SUGGESTIONS are the entire home
 *   suggestions feed; the server serves them as-is and recent chats are
 *   never interleaved. Each carries a `source` tag, though no screen reads
 *   it yet.
 * - SETTINGS_ITEMS feeds the command palette's settings results; `to` marks
 *   the entries that are real routes rather than in-place settings actions.
 * - PROVIDERS is dead weight from the port — nothing imports it; live
 *   provider health comes from GET /api/provider-health.
 */
import type { Model, Provider, Suggestion } from '../types';

export const PROVIDERS: Provider[] = [
  { id: 'anthropic', label: 'Anthropic', status: 'ok' },
  { id: 'openai', label: 'OpenAI', status: 'ok' },
  { id: 'google', label: 'Google', status: 'ok' },
  { id: 'meta', label: 'Meta', status: 'ok' },
  { id: 'serpapi', label: 'SerpAPI', status: 'ok' },
  { id: 'serper.dev', label: 'Serper.dev', status: 'ok' },
  { id: 'tavily', label: 'Tavily', status: 'ok' },
];

export const MODELS: Model[] = [
  {
    id: 'claude-4.5-sonnet',
    shortName: 'claude-4.5-sonnet',
    provider: 'anthropic',
    capabilities: {
      decisions: false,
      thinking: true,
      vision: true,
      tools: true,
      audio: false,
      json: true,
      fast: false,
    },
    thinkingLevels: ['off', 'low', 'medium', 'high'],
    context: { window: 200000, maxOutput: 8000 },
    pricing: { input: 3, cachedInput: 0.3, output: 15 },
    status: 'ok',
  },
  {
    id: 'gpt-5.2',
    shortName: 'gpt-5.2',
    provider: 'openai',
    capabilities: {
      decisions: false,
      thinking: true,
      vision: true,
      tools: true,
      audio: true,
      json: true,
      fast: false,
    },
    thinkingLevels: ['low', 'medium', 'high'],
    context: { window: 400000, maxOutput: 16000 },
    pricing: { input: 1.25, cachedInput: 0.125, output: 10 },
    status: 'ok',
  },
  {
    id: 'gemini-3-pro',
    shortName: 'gemini-3-pro',
    provider: 'google',
    capabilities: {
      decisions: false,
      thinking: true,
      vision: true,
      tools: true,
      audio: true,
      json: true,
      fast: false,
    },
    thinkingLevels: ['off', 'low', 'medium', 'high'],
    context: { window: 1000000, maxOutput: 64000 },
    pricing: { input: 0.5, cachedInput: 0.05, output: 3 },
    status: 'ok',
  },
  {
    id: 'claude-haiku-4.5',
    shortName: 'claude-haiku-4.5',
    provider: 'anthropic',
    capabilities: {
      decisions: false,
      thinking: false,
      vision: true,
      tools: true,
      audio: false,
      json: true,
      fast: true,
    },
    thinkingLevels: [],
    context: { window: 200000, maxOutput: 8000 },
    pricing: { input: 0.8, cachedInput: 0.08, output: 4 },
    status: 'ok',
  },
  {
    id: 'llama-4-maverick',
    shortName: 'llama-4-maverick',
    provider: 'meta',
    capabilities: {
      decisions: false,
      thinking: false,
      vision: true,
      tools: false,
      audio: false,
      json: false,
      fast: true,
    },
    // thinkingLevels intentionally absent → capability unknown (S7)
    context: { window: 128000, maxOutput: 16000 },
    pricing: { input: 0.2, cachedInput: 0.05, output: 0.6 },
    status: 'stale',
  },
  {
    id: 'gpt-5-mini',
    shortName: 'gpt-5-mini',
    provider: 'openai',
    capabilities: {
      decisions: false,
      thinking: true,
      vision: false,
      tools: true,
      audio: false,
      json: true,
      fast: true,
    },
    thinkingLevels: ['off', 'low', 'medium'],
    context: { window: 400000, maxOutput: 8000 },
    pricing: { input: 0.25, cachedInput: 0.025, output: 2 },
    status: 'ok',
  },
  {
    id: 'gemini-3-flash',
    shortName: 'gemini-3-flash',
    provider: 'google',
    capabilities: {
      decisions: false,
      thinking: true,
      vision: true,
      tools: true,
      audio: true,
      json: true,
      fast: true,
    },
    thinkingLevels: ['off', 'low'],
    context: { window: 1000000, maxOutput: 30000 },
    pricing: { input: 0.075, cachedInput: 0.0075, output: 0.3 },
    status: 'ok',
  },
  {
    id: 'o6-pro',
    shortName: 'o6-pro',
    provider: 'openai',
    capabilities: {
      decisions: false,
      thinking: true,
      vision: true,
      tools: true,
      audio: false,
      json: true,
      fast: false,
    },
    thinkingLevels: ['medium', 'high'],
    context: { window: 200000, maxOutput: 32000 },
    pricing: { input: 20, cachedInput: 2, output: 60, reasoning: 60 },
    status: 'error', // no API key configured → S6/S12 path exists
  },
];

export const STATIC_SUGGESTIONS: Suggestion[] = [
  {
    id: 's-r1',
    label: 'Explain a concept',
    icon: 'file',
    prompt:
      'Explain how a database index speeds up queries, when it slows writes down, and how to decide which columns to index. Use a small example table.',
    source: 'static',
  },
  {
    id: 's-r2',
    label: 'Debug an error',
    icon: 'wrench',
    prompt:
      'My Node.js app crashes with "TypeError: Cannot read properties of undefined (reading \'map\')" when an API response comes back empty. Walk me through the likely causes and show a defensive fix.',
    source: 'static',
  },
  {
    id: 's-r3',
    label: 'Summarize a topic',
    icon: 'note',
    prompt:
      'Summarize the trade-offs between REST, GraphQL and gRPC in 5 bullets, then say which fits a mobile app backed by many microservices.',
    source: 'static',
  },
  {
    id: 's-r4',
    label: 'Draft a checklist',
    icon: 'check',
    prompt:
      'Draft a production rollout checklist for shipping a database schema migration with zero downtime, covering prep, deploy, verification and rollback.',
    source: 'static',
  },
  {
    id: 's-r5',
    label: 'Critique UX copy',
    icon: 'chat',
    prompt:
      'Critique this empty-state copy for tone and brevity, then offer three tighter alternatives: "You don\'t have any projects yet. Projects are where you can organize all of your work. Click the button below to create your very first project and get started!"',
    source: 'static',
  },
];

export const PINNED_SUGGESTIONS: Suggestion[] = [
  {
    id: 's-p1',
    label: 'Write React UI',
    icon: 'grid',
    prompt:
      'Write a React component in TypeScript for a searchable, keyboard-navigable dropdown. Support arrow keys, Enter to select and Esc to close, and style it with Tailwind.',
    source: 'pinned',
  },
  {
    id: 's-p2',
    label: 'Design an API',
    icon: 'link',
    prompt:
      'Design a REST API for a simple todo app with users, lists and items. Give the endpoints, request/response shapes, status codes and how you would paginate and version it.',
    source: 'pinned',
  },
];

export const SETTINGS_ITEMS = [
  { id: 'set-theme', label: 'Appearance & theme', kind: 'settings' },
  {
    id: 'set-models',
    label: 'Models — capability overrides',
    kind: 'settings',
  },
  { id: 'set-providers', label: 'Provider keys & health', kind: 'settings' },
  { id: 'set-shortcuts', label: 'Keyboard shortcuts', kind: 'settings' },
  { id: 'set-tools', label: 'Default tool permissions', kind: 'settings' },
  {
    id: 'set-memories',
    label: 'Memories',
    kind: 'settings',
    to: '/settings/memories',
  },
  { id: 'set-data', label: 'Data controls — export / purge', kind: 'settings' },
];

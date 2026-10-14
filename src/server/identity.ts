/*
 * Identity — how talkative introduces itself to upstream providers.
 *
 * Business logic:
 * - every outbound provider request (model-list fetches in catalog,
 *   streaming chat completions in runs, background completions in
 *   complete) sends `user-agent: talkative/<version> (+<repo url>)`
 *   so providers see the app in their own request logs instead of an
 *   anonymous node fetch; VERSION is kept in sync with package.json.
 * - openrouter requests additionally carry app attribution headers
 *   (HTTP-Referer, X-OpenRouter-Title, X-OpenRouter-Categories),
 *   which lists the app in openrouter's public rankings, model
 *   "Apps" tabs and analytics. the referer url is the app's
 *   permanent identifier there — changing it later starts a fresh
 *   app — so treat it as frozen.
 */
const NAME = 'talkative';
const VERSION = '0.1.0';
const REPO_URL = 'https://github.com/fatihky/talkative';

export const USER_AGENT = `${NAME}/${VERSION} (+${REPO_URL})`;

export const OPENROUTER_ATTRIBUTION: Record<string, string> = {
  'HTTP-Referer': REPO_URL,
  'X-OpenRouter-Title': 'Talkative',
  'X-OpenRouter-Categories': 'general-chat,personal-agent',
};

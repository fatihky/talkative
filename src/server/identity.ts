/*
 * Identity — how talkative introduces itself to upstream providers.
 *
 * Business logic:
 * - every outbound provider request (model-list fetches in catalog,
 *   streaming chat completions in runs, background completions in
 *   complete) sends `user-agent: talkative/<version> (+<repo url>)`
 *   so providers see the app in their own request logs instead of an
 *   anonymous node fetch.
 * - VERSION is read from the package.json next to the running code at
 *   module load, never hardcoded: a hardcoded copy silently went stale
 *   (0.1.0 while the app shipped 0.2.x). waku inlines the source, so
 *   this file runs from the bundled chunk in dist/server/assets/, with
 *   the manifest two directories up; the walk upwards covers a plain
 *   waku dev run from the repo root as well.
 * - it's resolved once per process, so a failed read is cached too —
 *   not re-stat'ed on every upstream request.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'talkative';
const REPO_URL = 'https://github.com/fatihky/talkative';

/* the package.json version; undefined when no manifest is reachable */
function packageVersion(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let depth = 0; depth < 6; depth++) {
    const file = join(dir, 'package.json');
    try {
      if (existsSync(file)) {
        const { name, version } = JSON.parse(readFileSync(file, 'utf8')) as {
          name?: string;
          version?: string;
        };
        /* skip a parent package.json (a yarn/pnpm workspace root) when it
           clearly isn't ours */
        if (typeof version === 'string' && version.trim()) return version.trim();
        if (name) return undefined;
      }
    } catch {
      return undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const VERSION = packageVersion() ?? '0.0.0';

/* `talkative/<version>`, also used by the http_fetch tool's own agent */
export const PRODUCT = `${NAME}/${VERSION}`;

export const USER_AGENT = `${PRODUCT} (+${REPO_URL})`;

export const OPENROUTER_ATTRIBUTION: Record<string, string> = {
  'HTTP-Referer': REPO_URL,
  'X-OpenRouter-Title': 'Talkative',
  'X-OpenRouter-Categories': 'general-chat,personal-agent',
};

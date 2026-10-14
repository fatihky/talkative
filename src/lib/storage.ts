/*
 * storage — the client's only localStorage door, plus its id generators.
 *
 * Business logic:
 * - Client-only, used by the stores. Every key is prefixed `talkative.` and
 *   every access is wrapped in try/catch, so private mode or a full quota
 *   degrades to the fallback (get), a silent no-op (set/del) or false (has)
 *   instead of throwing during boot.
 * - There is no schema versioning: cached shapes are patched where they are
 *   read. boot fills in fields older caches lack (a chat's firstPrompt and
 *   createdAt) and drops cached notes without a numeric createdAt.
 * - Keys are namespaced by feature — cache.* are the stale-while-revalidate
 *   copies the stores write and boot reads once (models, modelsAt, chats,
 *   folders, notes), home.* is composer state (draft, lastModel,
 *   lastParams), plus layout.*, folders.expanded, prefs and theme.
 * - hasCache reports whether a models or chats cache exists; boot uses it to
 *   show the stage immediately instead of waiting out the cold-start delay.
 * - debouncedSet replaces the pending write for the same key, so the
 *   composer draft reaches localStorage at most once per 400ms.
 *   flushPending is an intentional no-op kept as a hook for reload flows.
 * - uid is a short random id for client-only things (toasts, optimistic
 *   messages); uuid builds a v4 from getRandomValues for ids the server
 *   stores (chats, notes, folders, attachments), because crypto.randomUUID
 *   is missing on plain-http LAN origins — see crypto-polyfill.
 */
const PREFIX = 'talkative.';

export const LS = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* private mode / quota — silent */
    }
  },
  del(key: string): void {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      /* ignore */
    }
  },
  has(key: string): boolean {
    try {
      return localStorage.getItem(PREFIX + key) !== null;
    } catch {
      return false;
    }
  },
};

export const hasCache = (): boolean =>
  LS.has('cache.models') || LS.has('cache.chats');

/** debounce helper that replaces prior pending write for the same key */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
export const debouncedSet = (key: string, value: unknown, ms = 400): void => {
  const t = timers.get(key);
  if (t) clearTimeout(t);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      LS.set(key, value);
    }, ms),
  );
};

export const flushPending = (): void => {
  // no-op hook kept for tests/reload flows
};

export const uid = (): string => Math.random().toString(36).slice(2, 10);

/* v4 uuid; crypto.randomUUID is missing on plain-http lan origins, getRandomValues isn't */
export const uuid = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

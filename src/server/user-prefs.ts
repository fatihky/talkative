/*
 * user-prefs — per-user composer/UI preferences that follow an account
 * across devices, stored in the app_settings key/value store under
 * 'user:<id>'.
 *
 * Business logic:
 * - Only preferences that are meant to travel are stored here; the theme
 *   stays a per-browser choice in localStorage (stores/prefs).
 * - The row is a partial object: a key that was never saved is absent, so
 *   the client can keep whatever it has cached instead of being reset to
 *   the default. A missing row means "nothing saved yet".
 * - `enterToSend` decides whether a bare Enter in the composer sends the
 *   message or inserts a newline (Shift+Enter always breaks, ⌘/Ctrl+Enter
 *   always sends).
 * - parseUserPrefs validates field by field and throws ValidationError on
 *   anything it doesn't recognize, so a typo'd key can't be stored.
 * - saveUserPrefs merges the patch into the stored row and returns the
 *   merged result; the key is scoped by user id, so one user can never
 *   read or write another's.
 */
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { appSettings } from '../db/schema';
import type { UserPrefs } from '../types';
import { ValidationError } from './errors';

/* one app_settings row per user, keyed by id */
const userPrefsKey = (userId: string) => `user:${userId}`;

/* merged over an empty object, so an unset key stays absent */
const parseStored = (value: unknown): UserPrefs => {
  const v = (value ?? {}) as Record<string, unknown>;
  const out: UserPrefs = {};
  if (typeof v.enterToSend === 'boolean') out.enterToSend = v.enterToSend;
  return out;
};

export const loadUserPrefs = async (userId: string): Promise<UserPrefs> => {
  const [row] = await getDb()
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, userPrefsKey(userId)));
  return parseStored(row?.value);
};

/* mutates only the keys it was given and returns the merged result */
export const saveUserPrefs = async (
  userId: string,
  patch: UserPrefs,
): Promise<UserPrefs> => {
  const next = { ...(await loadUserPrefs(userId)), ...patch };
  const key = userPrefsKey(userId);
  await getDb()
    .insert(appSettings)
    .values({ key, value: next })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: next, updatedAt: sql`now()` },
    });
  return next;
};

export const parseUserPrefs = (body: unknown): UserPrefs => {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: UserPrefs = {};
  if (b.enterToSend !== undefined) {
    if (typeof b.enterToSend !== 'boolean')
      throw new ValidationError('enterToSend must be a boolean');
    patch.enterToSend = b.enterToSend;
  }
  const unknown = Object.keys(b).filter(
    (k) => k !== 'enterToSend' && b[k] !== undefined,
  );
  if (unknown.length > 0)
    throw new ValidationError(`unknown preference: ${unknown.join(', ')}`);
  return patch;
};

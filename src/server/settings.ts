/*
 * settings — site-wide config and the admin/first-user rules built on it.
 *
 * Business logic:
 * - The whole site's config lives in one app_settings row under the key
 *   'site' as jsonb, merged over defaults so a stored row only has to
 *   carry the keys it overrides.
 * - Two knobs: registrationEnabled (sign-ups open/closed) and envKeyAccess
 *   ('all' | 'admins' | 'none' — who may use environment-provided tool
 *   keys), defaulting to registration open and env keys admin-only.
 * - parseSiteSettings coerces unknown/missing values back to the default,
 *   so a malformed row can't wedge the site; parseSettingsPatch validates
 *   an incoming PATCH field by field and throws ValidationError otherwise.
 * - saveSiteSettings upserts by key; patchSiteSettings does a read-modify-
 *   write of one merged object and returns the result.
 * - isFirstUser (true when the user table is empty) and isAdmin back the
 *   bootstrap rule in lib/auth: the first registrant is made admin and
 *   registration then closes. isAdmin defaults to false for an unknown id.
 */
import { eq, sql } from 'drizzle-orm';
import { getDb } from '../db';
import { appSettings, user } from '../db/schema';
import type { EnvKeyAccess, SiteSettings } from '../types';
import { ValidationError } from './errors';

/* every settings key and its default; stored one row per key */
export const SETTINGS_KEY = 'site';

const ENV_KEY_ACCESSES: readonly EnvKeyAccess[] = ['all', 'admins', 'none'];

export const defaultSiteSettings = (): SiteSettings => ({
  registrationEnabled: true,
  envKeyAccess: 'admins',
});

/* merged over defaults, so a stored row only needs the keys it overrides */
const parseSiteSettings = (value: unknown): SiteSettings => {
  const defaults = defaultSiteSettings();
  const v = (value ?? {}) as Record<string, unknown>;
  return {
    registrationEnabled:
      typeof v.registrationEnabled === 'boolean'
        ? v.registrationEnabled
        : defaults.registrationEnabled,
    envKeyAccess: ENV_KEY_ACCESSES.includes(v.envKeyAccess as EnvKeyAccess)
      ? (v.envKeyAccess as EnvKeyAccess)
      : defaults.envKeyAccess,
  };
};

export const getSiteSettings = async (): Promise<SiteSettings> => {
  const [row] = await getDb()
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, SETTINGS_KEY));
  return parseSiteSettings(row?.value);
};

export const saveSiteSettings = async (
  settings: SiteSettings,
): Promise<SiteSettings> => {
  const next = parseSiteSettings(settings);
  await getDb()
    .insert(appSettings)
    .values({ key: SETTINGS_KEY, value: next })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: next, updatedAt: sql`now()` },
    });
  return next;
};

/* mutates one key and returns the merged result */
export const patchSiteSettings = async (
  patch: Partial<SiteSettings>,
): Promise<SiteSettings> => {
  const current = await getSiteSettings();
  const next = parseSiteSettings({ ...current, ...patch });
  return saveSiteSettings(next);
};

export const parseSettingsPatch = (body: unknown): Partial<SiteSettings> => {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: Partial<SiteSettings> = {};
  if (b.registrationEnabled !== undefined) {
    if (typeof b.registrationEnabled !== 'boolean')
      throw new ValidationError('registrationEnabled must be a boolean');
    patch.registrationEnabled = b.registrationEnabled;
  }
  if (b.envKeyAccess !== undefined) {
    if (!ENV_KEY_ACCESSES.includes(b.envKeyAccess as EnvKeyAccess))
      throw new ValidationError(
        `envKeyAccess must be one of: ${ENV_KEY_ACCESSES.join(', ')}`,
      );
    patch.envKeyAccess = b.envKeyAccess as EnvKeyAccess;
  }
  return patch;
};

/* the first registered user owns the instance and is made admin */
export const isFirstUser = async (): Promise<boolean> => {
  const [row] = await getDb()
    .select({ count: sql<number>`count(*)` })
    .from(user);
  return Number(row?.count ?? 0) === 0;
};

export const isAdmin = async (userId: string): Promise<boolean> => {
  const [row] = await getDb()
    .select({ isAdmin: user.isAdmin })
    .from(user)
    .where(eq(user.id, userId));
  return row?.isAdmin ?? false;
};

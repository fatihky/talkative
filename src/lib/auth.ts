/*
 * auth — the server's better-auth instance: email+password sessions over
 * the Drizzle/pg schema, plus the first-user bootstrap.
 *
 * Business logic:
 * - Server-only: mounted wholesale by the /api/auth/[...all] route and used
 *   by src/server/auth.ts to resolve a session from request headers. The
 *   browser side is src/lib/auth-client.
 * - baseURL and secret come from BETTER_AUTH_URL and BETTER_AUTH_SECRET.
 *   trustedOrigins is BETTER_AUTH_URL plus BETTER_AUTH_TRUSTED_ORIGINS
 *   (comma-separated), empties filtered out: the deployed origin has to be
 *   listed or better-auth rejects requests from it, and there is no
 *   localhost default any more.
 * - A user.create database hook makes the very first registration the admin
 *   and immediately turns registrationEnabled off in site settings, so a
 *   public instance can't grow its own user base.
 * - Every later sign-up is refused (the hook returns false) while
 *   registration is off; admins add users through /api/users instead.
 */
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '../db';
import * as schema from '../db/schema';
import {
  getSiteSettings,
  isFirstUser,
  patchSiteSettings,
} from '../server/settings';

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,
  trustedOrigins: [
    process.env.BETTER_AUTH_URL,
    ...(process.env.BETTER_AUTH_TRUSTED_ORIGINS?.split(',') ?? []),
  ].filter((origin): origin is string => Boolean(origin)),
  database: drizzleAdapter(db, { provider: 'pg', schema }),
  emailAndPassword: { enabled: true },
  databaseHooks: {
    user: {
      create: {
        /* the first registered user becomes admin; later sign-ups are blocked
           once registration is turned off in settings */
        before: async (newUser) => {
          if (await isFirstUser()) {
            /* disable registration once the owner has signed up */
            await patchSiteSettings({ registrationEnabled: false });
            return { data: { ...newUser, isAdmin: true } };
          }
          const settings = await getSiteSettings();
          if (!settings.registrationEnabled) return false;
          return { data: newUser };
        },
      },
    },
  },
});

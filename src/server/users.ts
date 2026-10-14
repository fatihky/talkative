/*
 * users — the admin-facing CRUD over user records.
 *
 * Business logic:
 * - Backs the admin user-management routes (list, create, patch); every
 *   result goes through toUserDto, the one serialization boundary that
 *   exposes isAdmin and epoch-ms timestamps but never a password hash.
 * - MIN_PASSWORD is 8, matching better-auth's own sign-up floor, so a
 *   user minted here can still log in through the normal credential flow.
 * - parseName/parseEmail trim and normalize (email is lowercased) and
 *   enforce format/length, throwing ValidationError that the API maps to
 *   a 400 rather than a 500.
 * - createUser reproduces better-auth's credential sign-up by hand: it
 *   rejects a duplicate email, hashes the password, then inserts the user
 *   row and its matching 'credential' account row in one transaction so a
 *   half-created login can't exist. New users are always non-admin and
 *   emailVerified=false — admin status is never granted through here.
 * - updateUser patches only name/email and re-checks email uniqueness
 *   against every other user; it returns null when the id matches nobody.
 */
import { hashPassword } from 'better-auth/crypto';
import { and, asc, eq, ne } from 'drizzle-orm';
import { getDb } from '../db';
import { account, type UserRow, user } from '../db/schema';
import type { AdminUser } from '../types';
import { ValidationError } from './errors';

/* better-auth's default minimum password length */
const MIN_PASSWORD = 8;

export const toUserDto = (u: UserRow): AdminUser => ({
  id: u.id,
  name: u.name,
  email: u.email,
  isAdmin: u.isAdmin,
  createdAt: u.createdAt.getTime(),
  updatedAt: u.updatedAt.getTime(),
});

const parseName = (v: unknown): string => {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name) throw new ValidationError('name must be a non-empty string');
  if (name.length > 255) throw new ValidationError('name is too long');
  return name;
};

const parseEmail = (v: unknown): string => {
  const email = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (!email) throw new ValidationError('email must be a non-empty string');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new ValidationError('email is not valid');
  if (email.length > 255) throw new ValidationError('email is too long');
  return email;
};

export const parseUserCreate = (body: unknown) => {
  const b = (body ?? {}) as Record<string, unknown>;
  const password = typeof b.password === 'string' ? b.password : '';
  if (password.length < MIN_PASSWORD)
    throw new ValidationError(
      `password must be at least ${MIN_PASSWORD} characters`,
    );
  return { name: parseName(b.name), email: parseEmail(b.email), password };
};

export const parseUserPatch = (body: unknown) => {
  const b = (body ?? {}) as Record<string, unknown>;
  const patch: { email?: string; name?: string } = {};
  if (b.email !== undefined) patch.email = parseEmail(b.email);
  if (b.name !== undefined) patch.name = parseName(b.name);
  if (Object.keys(patch).length === 0)
    throw new ValidationError('nothing to update');
  return patch;
};

export const listUsers = async (): Promise<AdminUser[]> => {
  const rows = await getDb().select().from(user).orderBy(asc(user.createdAt));
  return rows.map(toUserDto);
};

/** creates a credential user the same way better-auth's sign-up does */
export const createUser = async (input: {
  name: string;
  email: string;
  password: string;
}): Promise<AdminUser> => {
  const db = getDb();
  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, input.email))
    .limit(1);
  if (existing)
    throw new ValidationError('a user with that email already exists');
  const password = await hashPassword(input.password);
  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(user)
      .values({
        id: crypto.randomUUID(),
        name: input.name,
        email: input.email,
        emailVerified: false,
        isAdmin: false,
      })
      .returning();
    if (!created) throw new Error('insert failed');
    await tx.insert(account).values({
      id: crypto.randomUUID(),
      accountId: created.id,
      providerId: 'credential',
      userId: created.id,
      password,
    });
    return created;
  });
  return toUserDto(row);
};

export const updateUser = async (
  id: string,
  patch: { email?: string; name?: string },
): Promise<AdminUser | null> => {
  const db = getDb();
  if (patch.email !== undefined) {
    const [clash] = await db
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.email, patch.email), ne(user.id, id)))
      .limit(1);
    if (clash) throw new ValidationError('a user with that email already exists');
  }
  const [row] = await db
    .update(user)
    .set(patch)
    .where(eq(user.id, id))
    .returning();
  return row ? toUserDto(row) : null;
};
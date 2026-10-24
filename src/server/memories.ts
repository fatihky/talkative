/*
 * server/memories — validation for the per-user key/value memory store.
 *
 * Business logic:
 * - a memory is a durable fact shared across all of a user's chats. the
 *   table is unique on (userId, key), so a key names exactly one memory per
 *   user and saving an existing key updates it instead of duplicating it.
 * - parseKey trims and rejects an empty key or one over 255 characters —
 *   deliberately the same trimming the `memory` tool applies, so a key the
 *   model saved and one typed in the settings UI match rather than forking
 *   into two memories.
 * - parseValue trims and rejects empty, so no memory is stored without a
 *   fact in it.
 * - parseMemoryCreate requires both; parseMemoryPatch touches only the
 *   fields present (undefined = leave as is), and the patch route re-checks
 *   key uniqueness when the key actually changes.
 * - nothing injects memories into a prompt on its own: the model sees them
 *   only by calling the memory tool's `list`, which returns the user's rows
 *   most recently touched first, and the settings pages read the same rows
 *   through /api/memories.
 * - visibility is per user everywhere — both memory routes filter by
 *   (id, userId) and answer memoryNotFound() for a foreign or unknown id,
 *   the collection route can wipe only the caller's memories, and deleting
 *   a user cascades their rows away.
 */
import type { MemoryRow } from '../db/schema';
import type { Memory as MemoryDto } from '../types';
import { ValidationError } from './providers';

export const toMemoryDto = (m: MemoryRow): MemoryDto => ({
  id: m.id,
  key: m.key,
  value: m.value,
  createdAt: m.createdAt.getTime(),
  updatedAt: m.updatedAt.getTime(),
});

export const memoryNotFound = () =>
  Response.json({ error: 'memory not found' }, { status: 404 });

/* same trimming as the memory tool, so UI edits and model saves agree on keys */
const parseKey = (v: unknown): string => {
  const key = typeof v === 'string' ? v.trim() : '';
  if (!key) throw new ValidationError('key must be a non-empty string');
  if (key.length > 255) throw new ValidationError('key is too long');
  return key;
};

const parseValue = (v: unknown): string => {
  const value = typeof v === 'string' ? v.trim() : '';
  if (!value) throw new ValidationError('value must be a non-empty string');
  return value;
};

export const parseMemoryCreate = (body: unknown) => {
  const b = (body ?? {}) as Record<string, unknown>;
  return { key: parseKey(b.key), value: parseValue(b.value) };
};

export const parseMemoryPatch = (body: unknown) => {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    ...(b.key !== undefined ? { key: parseKey(b.key) } : {}),
    ...(b.value !== undefined ? { value: parseValue(b.value) } : {}),
  };
};

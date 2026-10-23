/*
 * server/folders — the per-user folder tree that chats are filed into.
 *
 * Business logic:
 * - folders nest by parentId (null = top level) and belong to one user; the
 *   list route hands back the whole tree flat, ordered by name, and clients
 *   do the nesting.
 * - findFolder matches (id, userId), so another user's folder reads as
 *   missing and callers answer folderNotFound() — a 404, never a 403.
 * - parseFolderCreate accepts a client-minted uuid so the folder can appear
 *   in the sidebar before the request lands; the route rejects an id that
 *   already exists, whoever owns it.
 * - names are trimmed, must be non-empty and are capped at 255 characters,
 *   while parseFolderRef reads undefined as "leave as is", null as "top
 *   level" and anything else as a uuid.
 * - parseFolderPatch reuses parseSystemPrompt from chats.ts, so a folder's
 *   prompt obeys the same blank-clears rule as a chat's. folder
 *   prompts are stacked outermost-first, ahead of the chat's own, when a
 *   run builds its system turns.
 * - assertParent loads all of the user's folders once, requires the new
 *   parent to be one of them, then walks up from it: meeting the folder
 *   being moved means the move would close a cycle, so it is rejected
 *   before anything is written.
 * - removeFolder never drops contents — in one transaction it re-parents the
 *   folder's subfolders and moves its chats to the folder's own parent
 *   (null = top level), then deletes the row. deleting a folder is a move
 *   up, not a cascade.
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db';
import type { FolderRow } from '../db/schema';
import { chats, folders } from '../db/schema';
import type { Folder as FolderDto } from '../types';
import { isUuid, parseSystemPrompt } from './chats';
import { ValidationError } from './providers';

export const toFolderDto = (f: FolderRow): FolderDto => ({
  id: f.id,
  name: f.name,
  parentId: f.parentId ?? null,
  ...(f.systemPrompt ? { systemPrompt: f.systemPrompt } : {}),
  createdAt: f.createdAt.getTime(),
});

export const folderNotFound = () =>
  Response.json({ error: 'folder not found' }, { status: 404 });

const parseName = (v: unknown): string => {
  const name = typeof v === 'string' ? v.trim() : '';
  if (!name) throw new ValidationError('name must be a non-empty string');
  if (name.length > 255) throw new ValidationError('name is too long');
  return name;
};

/* undefined = leave as is, null = top level */
export const parseFolderRef = (v: unknown, field: string) => {
  if (v === undefined || v === null) return v;
  if (typeof v !== 'string' || !isUuid(v))
    throw new ValidationError(`${field} must be a folder id or null`);
  return v;
};

export const parseFolderCreate = (body: unknown) => {
  const b = (body ?? {}) as Record<string, unknown>;
  /* clients mint the id so the folder can be shown before the request lands */
  if (b.id !== undefined && (typeof b.id !== 'string' || !isUuid(b.id)))
    throw new ValidationError('id must be a uuid');
  return {
    ...(typeof b.id === 'string' ? { id: b.id } : {}),
    name: parseName(b.name),
    parentId: parseFolderRef(b.parentId, 'parentId') ?? null,
  };
};

export const parseFolderPatch = (body: unknown) => {
  const b = (body ?? {}) as Record<string, unknown>;
  const parentId = parseFolderRef(b.parentId, 'parentId');
  const systemPrompt = parseSystemPrompt(b.systemPrompt);
  return {
    ...(b.name !== undefined ? { name: parseName(b.name) } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  };
};

/** the user's folder with this id; someone else's reads as missing */
export const findFolder = (db: Db, userId: string, id: string) =>
  db
    .select()
    .from(folders)
    .where(and(eq(folders.id, id), eq(folders.userId, userId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);

/** throws unless `parentId` is one of the user's folders and isn't `id` itself or one of its descendants */
export const assertParent = async (
  db: Db,
  userId: string,
  parentId: string | null,
  id?: string,
) => {
  if (parentId === null) return;
  const all = await db
    .select({ id: folders.id, parentId: folders.parentId })
    .from(folders)
    .where(eq(folders.userId, userId));
  const parentOf = new Map(all.map((f) => [f.id, f.parentId ?? null]));
  if (!parentOf.has(parentId))
    throw new ValidationError('parent folder not found');
  /* walk up from the new parent; meeting `id` means the move would form a cycle */
  for (let cur: string | null = parentId; cur !== null; ) {
    if (cur === id)
      throw new ValidationError('a folder cannot be moved into itself');
    cur = parentOf.get(cur) ?? null;
  }
};

/* deleting a folder hands its subfolders and chats to its parent instead of dropping them */
export const removeFolder = (db: Db, folder: FolderRow) =>
  db.transaction(async (tx) => {
    const parentId = folder.parentId ?? null;
    await tx
      .update(folders)
      .set({ parentId })
      .where(eq(folders.parentId, folder.id));
    await tx
      .update(chats)
      .set({ folderId: parentId })
      .where(eq(chats.folderId, folder.id));
    await tx.delete(folders).where(eq(folders.id, folder.id));
  });
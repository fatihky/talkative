/*
 * server/notes — reusable notes a user can attach to a turn.
 *
 * Business logic:
 * - a note is a per-user title + text document. a turn references it as a
 *   `kind: 'note'` attachment carrying noteId, so the message stores only
 *   the reference and later generations pick up whatever the note says now.
 * - toNoteDto ships id, title, text and both timestamps, and no userId.
 * - titles are trimmed, must be non-empty and are capped at 255 characters;
 *   text only has to be a string, defaults to '' on create and is stored
 *   exactly as sent, so a note's whitespace and formatting survive.
 * - parseNoteCreate accepts a client-minted uuid so the editor can open
 *   before the request lands; the route rejects an id that already exists.
 * - parseNotePatch touches only the fields present in the body, undefined
 *   meaning "leave as is"; both note routes scope their write by
 *   (id, userId) and answer noteNotFound() for a foreign or unknown id.
 * - attachedNotes is the generation-side read: it collects the distinct
 *   uuid noteIds across the given messages and returns title + text by id,
 *   fetched under the caller's userId.
 * - a deleted note, or an id belonging to someone else, is simply absent
 *   from that map, so userContent drops the block instead of failing the
 *   send — a stale note attachment never breaks a run.
 */
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db';
import type { MessageRow, NoteRow } from '../db/schema';
import { notes } from '../db/schema';
import type { Note as NoteDto } from '../types';
import { isUuid } from './chats';
import { ValidationError } from './providers';
import type { NoteTexts } from './runs';

export const toNoteDto = (n: NoteRow): NoteDto => ({
  id: n.id,
  title: n.title,
  text: n.text,
  createdAt: n.createdAt.getTime(),
  updatedAt: n.updatedAt.getTime(),
});

export const noteNotFound = () =>
  Response.json({ error: 'note not found' }, { status: 404 });

const parseTitle = (v: unknown): string => {
  const title = typeof v === 'string' ? v.trim() : '';
  if (!title) throw new ValidationError('title must be a non-empty string');
  if (title.length > 255) throw new ValidationError('title is too long');
  return title;
};

const parseText = (v: unknown): string => {
  if (typeof v !== 'string') throw new ValidationError('text must be a string');
  return v;
};

export const parseNoteCreate = (body: unknown) => {
  const b = (body ?? {}) as Record<string, unknown>;
  /* clients mint the id so the editor can open before the request lands */
  if (b.id !== undefined && (typeof b.id !== 'string' || !isUuid(b.id)))
    throw new ValidationError('id must be a uuid');
  return {
    ...(typeof b.id === 'string' ? { id: b.id } : {}),
    title: parseTitle(b.title),
    text: b.text === undefined ? '' : parseText(b.text),
  };
};

export const parseNotePatch = (body: unknown) => {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    ...(b.title !== undefined ? { title: parseTitle(b.title) } : {}),
    ...(b.text !== undefined ? { text: parseText(b.text) } : {}),
  };
};

/* bodies of the notes attached across `msgs`, by id; deleted notes are simply absent */
export const attachedNotes = async (
  db: Db,
  userId: string,
  msgs: Pick<MessageRow, 'attachments'>[],
): Promise<NoteTexts> => {
  const ids = [
    ...new Set(
      msgs.flatMap((m) =>
        (m.attachments as Array<{ kind: string; noteId?: string }>).flatMap(
          (a) =>
            a.kind === 'note' && a.noteId && isUuid(a.noteId) ? [a.noteId] : [],
        ),
      ),
    ),
  ];
  if (ids.length === 0) return new Map();
  const found = await db
    .select()
    .from(notes)
    .where(and(inArray(notes.id, ids), eq(notes.userId, userId)));
  return new Map(found.map((n) => [n.id, { title: n.title, text: n.text }]));
};
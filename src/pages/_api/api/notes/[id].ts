/*
 * NoteItem — PATCH/DELETE /api/notes/:id — edit or remove one note.
 *
 * Business logic:
 * - auth via handle(); :id must be a uuid, else 404 (noteNotFound) —
 *   a malformed id can't match a row anyway.
 * - PATCH takes only the fields present in the body via
 *   parseNotePatch (title and/or text, same limits as create: title
 *   non-empty and ≤255); ValidationError → 400.
 * - ownership lives in the WHERE clause (id AND userId) for both
 *   verbs, so a foreign note matches zero rows and reads as 404 — the
 *   same response as a missing one, no existence leak.
 * - PATCH returns the updated DTO; DELETE returns 204 on success.
 * - messages reference notes by id inside their attachments jsonb, so
 *   deleting does NOT cascade or prune anything: attachedNotes()
 *   simply skips absent notes the next time a generation inlines them,
 *   and already-built history keeps whatever text it captured.
 */
import { and, eq } from 'drizzle-orm';
import type { ApiContext } from 'waku/router';
import { getDb } from '../../../../db';
import { notes } from '../../../../db/schema';
import { isUuid } from '../../../../server/chats';
import {
  noteNotFound,
  parseNotePatch,
  toNoteDto,
} from '../../../../server/notes';
import { handle } from '../../../../server/providers';

type Ctx = ApiContext<'/api/notes/[id]'>;

/* PATCH /api/notes/:id — title and/or body */
export const PATCH = (req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return noteNotFound();
    const patch = parseNotePatch(await req.json());
    const [note] = await getDb()
      .update(notes)
      .set(patch)
      .where(and(eq(notes.id, params.id), eq(notes.userId, userId)))
      .returning();
    if (!note) return noteNotFound();
    return Response.json(toNoteDto(note));
  });

export const DELETE = (_req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return noteNotFound();
    const deleted = await getDb()
      .delete(notes)
      .where(and(eq(notes.id, params.id), eq(notes.userId, userId)))
      .returning({ id: notes.id });
    if (deleted.length === 0) return noteNotFound();
    return new Response(null, { status: 204 });
  });
/*
 * Notes — GET/POST /api/notes — list and create the user's notes.
 *
 * Business logic:
 * - auth via handle() for both verbs; every query is scoped by userId,
 *   so notes are strictly per-user.
 * - GET returns the newest 500 (createdAt desc) as DTOs — the cap
 *   keeps the notes screen and attachment picker bounded.
 * - POST body goes through parseNoteCreate: title required, non-empty
 *   and ≤255 chars, text optional (defaults to ''); failures throw
 *   ValidationError → 400.
 * - clients may mint the uuid id so the editor can open the note
 *   before the request lands (optimistic create); a supplied id that
 *   already exists — checked globally, since ids are primary keys — is
 *   rejected with 400 rather than overwriting the other note.
 * - success returns the stored row's DTO with 201; a vanished insert
 *   throws → 500.
 * - notes are referenced from messages' attachments jsonb by id, so
 *   creating one never touches chats; deletion semantics live in
 *   /api/notes/:id.
 */
import { desc, eq } from 'drizzle-orm';
import { getDb } from '../../../db';
import { notes } from '../../../db/schema';
import { parseNoteCreate, toNoteDto } from '../../../server/notes';
import { handle, ValidationError } from '../../../server/providers';

/* GET /api/notes — newest first */
export const GET = () =>
  handle(async (userId) => {
    const rows = await getDb()
      .select()
      .from(notes)
      .where(eq(notes.userId, userId))
      .orderBy(desc(notes.createdAt))
      .limit(500);
    return Response.json(rows.map(toNoteDto));
  });

export const POST = (req: Request) =>
  handle(async (userId) => {
    const input = parseNoteCreate(await req.json());
    if (input.id) {
      const existing = await getDb()
        .select({ id: notes.id })
        .from(notes)
        .where(eq(notes.id, input.id))
        .limit(1);
      if (existing.length > 0)
        throw new ValidationError('note id already exists');
    }
    const [note] = await getDb()
      .insert(notes)
      .values({ ...input, userId })
      .returning();
    if (!note) throw new Error('insert failed');
    return Response.json(toNoteDto(note), { status: 201 });
  });

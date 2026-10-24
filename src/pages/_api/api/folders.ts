/*
 * folders — GET/POST /api/folders — the caller's folder tree, and how
 * a folder is added to it.
 *
 * Business logic:
 * - auth via handle() (401 without a session); both verbs are
 *   per-user, with no admin path — folders are private organisation,
 *   not instance policy.
 * - GET returns the whole tree flat, ordered by name; nesting by
 *   parentId is the client's job (16b80a3). No limit: a user's folder
 *   count is bounded by the sidebar, not by this query.
 * - POST is parseFolderCreate: a trimmed, non-empty name ≤255 chars,
 *   an optional parentId (undefined or null = top level, else a uuid)
 *   and an optional client-minted uuid id, so the folder can appear in
 *   the sidebar before the request lands. Any shape miss is a
 *   ValidationError → 400.
 * - a supplied id that already exists is a 400, checked across all
 *   users because ids are primary keys — a collision is refused rather
 *   than silently overwriting someone's folder.
 * - assertParent() must pass before the insert: the parent has to be
 *   one of the caller's folders (400 'parent folder not found'), which
 *   is also what stops a folder being filed into someone else's tree.
 *   Cycle checking only matters on move, so it lives in the PATCH
 *   route.
 * - 201 with the folder dto on success; a vanished insert throws → 500.
 * - a folder's systemPrompt is inherited by every chat and subfolder
 *   inside it when a run builds its system turns, so this shape has
 *   consequences beyond tidiness — but that field is set through PATCH
 *   /api/folders/:id, not here.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../../db';
import { folders } from '../../../db/schema';
import {
  assertParent,
  parseFolderCreate,
  toFolderDto,
} from '../../../server/folders';
import { handle, ValidationError } from '../../../server/providers';

/* GET /api/folders — the whole tree, flat; clients nest by parentId */
export const GET = () =>
  handle(async (userId) => {
    const rows = await getDb()
      .select()
      .from(folders)
      .where(eq(folders.userId, userId))
      .orderBy(asc(folders.name));
    return Response.json(rows.map(toFolderDto));
  });

export const POST = (req: Request) =>
  handle(async (userId) => {
    const input = parseFolderCreate(await req.json());
    const db = getDb();
    if (input.id) {
      const [result] = await db
        .select({ count: sql<number>`count(*)` })
        .from(folders)
        .where(eq(folders.id, input.id));
      if (Number(result?.count ?? 0) > 0)
        throw new ValidationError('folder id already exists');
    }
    await assertParent(db, userId, input.parentId);
    const [folder] = await db
      .insert(folders)
      .values({ ...input, userId })
      .returning();
    if (!folder) throw new Error('insert failed');
    return Response.json(toFolderDto(folder), { status: 201 });
  });

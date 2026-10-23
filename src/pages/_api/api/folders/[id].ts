/*
 * folders/[id] — PATCH/DELETE /api/folders/:id — rename, re-parent or
 * remove one of the caller's folders.
 *
 * Business logic:
 * - auth via handle(); uuid guard, then findFolder(id, userId), so a
 *   missing or foreign folder answers folderNotFound() 404 — never
 *   403, no existence leak.
 * - PATCH is parseFolderPatch's whitelist: name (non-empty, ≤255),
 *   parentId (null = top level) and systemPrompt (shared with chats:
 *   blank clears). Undefined means "leave as is"; a
 *   malformed field is a 400, and an empty body leaves nothing to set,
 *   which the update rejects as a 500 rather than a 400.
 * - a parentId in the patch goes through assertParent(db, userId,
 *   parentId, folder.id): the new parent must be one of the caller's
 *   folders, and walking up from it must not meet the folder being
 *   moved. A cycle would spin forever in systemTurns() and in the
 *   sidebar's nesting, so the move is refused with 400 before anything
 *   is written.
 * - the systemPrompt is inherited by every chat and subfolder inside,
 *   stacked outermost-first ahead of the chat's own, so a PATCH here
 *   silently changes what all of them send to the model on their next
 *   run — already-stored replies are untouched.
 * - DELETE never drops contents: removeFolder() re-parents the folder's
 *   subfolders and moves its chats to the folder's own parent (null =
 *   top level) in one transaction, then deletes the row. Deleting a
 *   folder is a move up, not a cascade, so chats survive and there is
 *   no pruneAttachments() cleanup to trigger. 204, no body.
 * - 200 with the updated dto on PATCH; a lost write race throws → 500.
 */
import { eq } from 'drizzle-orm';
import type { ApiContext } from 'waku/router';
import { getDb } from '../../../../db';
import { folders } from '../../../../db/schema';
import { isUuid } from '../../../../server/chats';
import {
  assertParent,
  findFolder,
  folderNotFound,
  parseFolderPatch,
  removeFolder,
  toFolderDto,
} from '../../../../server/folders';
import { handle } from '../../../../server/providers';

type Ctx = ApiContext<'/api/folders/[id]'>;

/* PATCH /api/folders/:id — rename, set the system prompt, and/or move under another folder (null = top level) */
export const PATCH = (req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return folderNotFound();
    const patch = parseFolderPatch(await req.json());
    const db = getDb();
    const folder = await findFolder(db, userId, params.id);
    if (!folder) return folderNotFound();
    if (patch.parentId !== undefined)
      await assertParent(db, userId, patch.parentId, folder.id);
    const [updated] = await db
      .update(folders)
      .set(patch)
      .where(eq(folders.id, folder.id))
      .returning();
    if (!updated) throw new Error('update failed');
    return Response.json(toFolderDto(updated));
  });

/* DELETE /api/folders/:id — contents move up to the parent folder */
export const DELETE = (_req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return folderNotFound();
    const db = getDb();
    const folder = await findFolder(db, userId, params.id);
    if (!folder) return folderNotFound();
    await removeFolder(db, folder);
    return new Response(null, { status: 204 });
  });
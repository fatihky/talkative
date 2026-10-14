/*
 * attachments/[id] — GET /api/attachments/:id — serve one stored
 * upload's bytes back to its owner.
 *
 * Business logic:
 * - auth via handle() (401 without a session); findAttachment()
 *   matches (id, userId), so another user's upload is
 *   indistinguishable from a missing one. Read-only, no admin path.
 * - three ways to the same 404 'attachment not found': a :id that
 *   isn't a uuid (rejected before any query), no matching row, and no
 *   bytes — an image whose file vanished from $UPLOADS_DIR or a row
 *   whose `data` is null. A lost upload therefore reads as "not
 *   found", not as a 500, since readUpload() returns null instead of
 *   throwing.
 * - the byte source mirrors POST's storage split (0566e55): images
 *   are read off the filesystem, everything else comes from the
 *   postgres `data` column.
 * - served inline with the stored mime and length; quotes are stripped
 *   from the filename before it goes into content-disposition, so a
 *   crafted upload name can't break out of the header.
 * - cache-control is `private, max-age=31536000, immutable`: private
 *   because the bytes belong to one user, immutable because an id's
 *   content is fixed once stored — that's what makes inline images
 *   and repeat downloads cheap.
 * - no reference counting or pruning here: removing uploads is
 *   pruneAttachments()'s job from the message and chat routes.
 */
import type { ApiContext } from 'waku/router';
import { getDb } from '../../../../db';
import {
  findAttachment,
  isImageMime,
} from '../../../../server/attachments';
import { isUuid } from '../../../../server/chats';
import { handle } from '../../../../server/providers';
import { readUpload } from '../../../../server/uploads';

type Ctx = ApiContext<'/api/attachments/[id]'>;

/* GET /api/attachments/:id — the stored file bytes; images come from the filesystem */
export const GET = (_req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id))
      return Response.json({ error: 'attachment not found' }, { status: 404 });
    const row = await findAttachment(getDb(), userId, params.id);
    if (!row)
      return Response.json({ error: 'attachment not found' }, { status: 404 });
    const bytes = isImageMime(row.mime)
      ? await readUpload(userId, row.id)
      : row.data;
    if (!bytes)
      return Response.json({ error: 'attachment not found' }, { status: 404 });
    return new Response(new Uint8Array(bytes), {
      headers: {
        'content-type': row.mime,
        'content-length': String(bytes.length),
        'content-disposition': `inline; filename="${row.name.replace(/"/g, '')}"`,
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
  });

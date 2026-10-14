/*
 * attachments — POST/GET /api/attachments — store an upload under a
 * client-minted id, and read upload metadata back.
 *
 * Business logic:
 * - auth via handle(); every read and write is bound to the session's
 *   userId, which is also the uploads directory an image lands in.
 * - POST takes multipart form-data: `file` must be a File and `id` a
 *   client-minted uuid (parseAttachmentId) — both failures are
 *   ValidationError → 400. The client picks the id up front so a
 *   message can reference the upload before it is stored, and so an
 *   edit or a resend can carry the same id onto another branch.
 * - size caps differ by mime: IMAGE_MAX_BYTES (20MB) for images,
 *   ATTACHMENT_MAX_BYTES (10MB) for everything else, and the 400
 *   message names the cap in whole MB.
 * - storage split (0566e55): images go to saveUpload() on disk with a
 *   null `data` column, other files keep their bytes in postgres so
 *   withAttachmentText() can inline text-ish mimes into a prompt
 *   later. Re-uploading an id the caller already owns overwrites it
 *   (idempotent); an id owned by someone else is a 400 'attachment id
 *   already exists', never a silent overwrite and never a 403.
 * - side effect to keep in sync: the row and, for images, the file at
 *   $UPLOADS_DIR/<userId>/<id> are one unit. Nothing here deletes
 *   them — messages reference the id from their jsonb, so only
 *   pruneAttachments() (from the message/chat delete routes) or
 *   `pnpm uploads:gc` may, and only once no surviving turn of that
 *   user points at the id.
 * - the POST response is the metadata a message stores
 *   (id/name/bytes/mime) with kind 'file' and no url; the client
 *   decides image vs file from the mime and builds urls itself.
 * - GET ?ids=a,b resolves metadata plus the serving url
 *   (/api/attachments/:id) per id: non-uuid entries are dropped and
 *   ids that are missing or belong to someone else are skipped
 *   silently, so a foreign id reads as absent instead of 404/403.
 *   One query per id, answered in request order; an empty or absent
 *   `ids` is a 200 with [].
 */
import { eq } from 'drizzle-orm';
import { getDb } from '../../../db';
import { attachments } from '../../../db/schema';
import {
  ATTACHMENT_MAX_BYTES,
  IMAGE_MAX_BYTES,
  isImageMime,
  parseAttachmentId,
} from '../../../server/attachments';
import { isUuid } from '../../../server/chats';
import { handle, ValidationError } from '../../../server/providers';
import { saveUpload } from '../../../server/uploads';

/*
 * POST /api/attachments — stores an uploaded file/image under the client-minted id.
 * the returned metadata (id/name/bytes/mime) is what the message carries; the id is
 * also the URL used by GET /api/attachments/:id. text files are inlined during generation.
 */
export const POST = (req: Request) =>
  handle(async (userId) => {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File))
      throw new ValidationError('file field is required');
    const image = isImageMime(file.type);
    const maxBytes = image ? IMAGE_MAX_BYTES : ATTACHMENT_MAX_BYTES;
    if (file.size > maxBytes)
      throw new ValidationError(
        `file is over ${Math.round(maxBytes / 1024 / 1024)}MB`,
      );
    const id = parseAttachmentId({ id: form.get('id') });
    if (!id) throw new ValidationError('id must be a uuid');
    const data = Buffer.from(await file.arrayBuffer());
    const db = getDb();
    const existing = await db
      .select({ userId: attachments.userId })
      .from(attachments)
      .where(eq(attachments.id, id))
      .limit(1);
    if (existing[0] && existing[0].userId !== userId)
      throw new ValidationError('attachment id already exists');
    const values = {
      id,
      userId,
      name: file.name || 'upload',
      mime: file.type || 'application/octet-stream',
      bytes: data.length,
      /* images are stored as files and served back as vision inputs; text and
         other files keep their bytes in postgres so they can be inlined */
      data: image ? null : data,
    };
    if (image) {
      await saveUpload(userId, id, data);
    }
    if (existing[0])
      await db.update(attachments).set(values).where(eq(attachments.id, id));
    else await db.insert(attachments).values(values);
    return Response.json({
      id,
      kind: 'file',
      name: values.name,
      bytes: values.bytes,
      mime: values.mime,
    });
  });

/* GET /api/attachments?ids=a,b — metadata + a fetchable url for each id */
export const GET = (req: Request) =>
  handle(async (userId) => {
    const raw = new URL(req.url).searchParams.get('ids') ?? '';
    const ids = raw.split(',').filter((s) => isUuid(s));
    const out: {
      id: string;
      kind: 'file';
      name: string;
      bytes: number;
      mime: string;
      url: string;
    }[] = [];
    for (const id of ids) {
      const [row] = await getDb()
        .select()
        .from(attachments)
        .where(eq(attachments.id, id))
        .limit(1);
      if (!row || row.userId !== userId) continue;
      out.push({
        id: row.id,
        kind: 'file',
        name: row.name,
        bytes: row.bytes,
        mime: row.mime,
        url: `/api/attachments/${row.id}`,
      });
    }
    return Response.json(out);
  });

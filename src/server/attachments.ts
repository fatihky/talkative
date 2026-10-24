/*
 * server/attachments — the upload lifecycle between messages and storage.
 *
 * Business logic:
 * - an upload is an `attachments` row plus, for images, a file at
 *   $UPLOADS_DIR/<userId>/<attachmentId> (uploads.ts). messages reference
 *   it by id inside their `attachments` jsonb, so nothing cascades on its
 *   own: every route that deletes messages or a chat must hand the removed
 *   turns to pruneAttachments().
 * - storedAttachmentIds is what to hand over — the distinct uuid ids of
 *   file/image attachments, since note and url attachments store no bytes.
 * - pruneAttachments drops the row and the file only for ids that no
 *   surviving message of that user still references. an edit or a resend
 *   reuses the same id onto another branch, so an upload never goes while
 *   another turn points at it.
 * - the reference check is jsonb containment, one `@>` clause per id over
 *   the user's own messages joined through their chats, sliced at
 *   IDS_PER_QUERY (50) so the or-list per query stays bounded.
 * - pruning is best effort and runs after the delete that triggered it has
 *   committed, so a failure only warns and returns 0 rather than failing
 *   the request; `pnpm uploads:gc` collects whatever slipped through.
 * - withAttachmentText is the generation-side read: text, json and xml
 *   attachments gain `text` decoded from the row and cut at TEXT_MAX
 *   (200k), images gain a base64 `dataUrl` taken from the row or read off
 *   disk, and every other mime passes through unchanged. rows are fetched
 *   under the caller's userId, so a foreign id reads as absent.
 * - stripText removes `text`/`dataUrl` before a message row is written: the
 *   extracted copies are recomputed per run and never stored, so the jsonb
 *   keeps only the metadata (id/kind/name/mime) the UI needs.
 * - ATTACHMENT_MAX_BYTES (10MB) and IMAGE_MAX_BYTES (20MB) are the caps the
 *   upload route enforces, and parseAttachmentId accepts only a uuid — the
 *   same id is the path used to fetch the bytes back.
 */
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { getDb } from '../db';
import { type AttachmentRow, attachments, chats, messages } from '../db/schema';
import type { Attachment } from '../types';
import { isUuid } from './chats';
import type { InlineAttachment } from './runs';
import { deleteUpload, readUpload } from './uploads';

/* text attachments are inlined into the prompt; other binaries are stored but not read */
export const TEXT_MAX = 200_000;
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;

const isTextMime = (mime: string | undefined): boolean =>
  !!mime &&
  (mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/xml');

export const isImageMime = (mime: string | undefined): boolean =>
  !!mime && mime.startsWith('image/');

export const parseAttachmentId = (body: unknown): string | null => {
  const b = (body ?? {}) as Record<string, unknown>;
  return typeof b.id === 'string' && isUuid(b.id) ? b.id : null;
};

export const attachmentNotFound = () =>
  Response.json({ error: 'attachment not found' }, { status: 404 });

export const findAttachment = (db: Db, userId: string, id: string) =>
  db
    .select()
    .from(attachments)
    .where(and(eq(attachments.id, id), eq(attachments.userId, userId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);

/* strips the stored text and image data so a message row keeps only the metadata the UI needs */
export const stripText = (a: InlineAttachment): Attachment => {
  const { text: _text, dataUrl: _dataUrl, ...rest } = a;
  return rest;
};

/** ids of the uploads these messages carry; note/url attachments have no stored bytes */
export const storedAttachmentIds = (
  msgs: Array<{ attachments: unknown }>,
): string[] => [
  ...new Set(
    msgs.flatMap((m) =>
      ((m.attachments as InlineAttachment[] | null) ?? []).flatMap((a) =>
        a.id && isUuid(a.id) && (a.kind === 'file' || a.kind === 'image')
          ? [a.id]
          : [],
      ),
    ),
  ),
];

/* containment is checked one id at a time, so keep the or-list per query bounded */
const IDS_PER_QUERY = 50;

/** the ids of `ids` that one of the user's messages still references */
const referencedIds = async (
  db: Db,
  userId: string,
  ids: string[],
): Promise<Set<string>> => {
  const used = new Set<string>();
  for (let i = 0; i < ids.length; i += IDS_PER_QUERY) {
    const slice = ids.slice(i, i + IDS_PER_QUERY);
    const rows = await db
      .select({ attachments: messages.attachments })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .where(
        and(
          eq(chats.userId, userId),
          or(
            ...slice.map(
              (id) =>
                sql`${messages.attachments} @> ${JSON.stringify([{ id }])}::jsonb`,
            ),
          ),
        ),
      );
    const wanted = new Set(slice);
    for (const id of storedAttachmentIds(rows))
      if (wanted.has(id)) used.add(id);
  }
  return used;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * drops the uploads behind `ids` once no message of the user's references them, row and file
 * together. an edit or a resend carries the same id onto a surviving branch, so nothing goes
 * while another turn still points at it. best effort: a failed cleanup only warns, since the
 * deletion that triggered it has already committed. returns how many uploads were removed.
 */
export const pruneAttachments = async (
  userId: string,
  ids: Iterable<string>,
): Promise<number> => {
  const wanted = [...new Set(ids)].filter(isUuid);
  if (wanted.length === 0) return 0;
  try {
    const db = getDb();
    const used = await referencedIds(db, userId, wanted);
    const gone = wanted.filter((id) => !used.has(id));
    if (gone.length === 0) return 0;
    await db
      .delete(attachments)
      .where(
        and(inArray(attachments.id, gone), eq(attachments.userId, userId)),
      );
    await Promise.all(gone.map((id) => deleteUpload(userId, id)));
    return gone.length;
  } catch (e) {
    console.warn(`[attachments] prune failed: ${errorText(e)}`);
    return 0;
  }
};

/**
 * enriches the attachments on the given messages with stored file text, so
 * `userContent` can inline it. url/note pass through unchanged; images gain a
 * `dataUrl` so vision-capable models receive them as image content parts.
 */
export const withAttachmentText = async (
  userId: string,
  msgs: Array<{ attachments: unknown }>,
): Promise<InlineAttachment[][]> => {
  const perMsg = msgs.map(
    (m) => (m.attachments as InlineAttachment[] | null) ?? [],
  );
  const ids = storedAttachmentIds(msgs);
  const byId = new Map<string, AttachmentRow>();
  if (ids.length > 0) {
    const found = await getDb()
      .select()
      .from(attachments)
      .where(and(inArray(attachments.id, ids), eq(attachments.userId, userId)));
    for (const r of found) byId.set(r.id, r);
  }
  return Promise.all(
    perMsg.map((list) =>
      Promise.all(
        list.map(async (a) => {
          const row = a.id ? byId.get(a.id) : undefined;
          if (!row) return a;
          if (isImageMime(row.mime)) {
            const data =
              row.data ?? (a.id ? await readUpload(userId, a.id) : null);
            return data
              ? {
                  ...a,
                  dataUrl: `data:${row.mime};base64,${Buffer.from(data).toString('base64')}`,
                }
              : a;
          }
          if (!isTextMime(row.mime)) return a;
          if (!row.data) return a;
          return {
            ...a,
            text: Buffer.from(row.data).toString('utf8').slice(0, TEXT_MAX),
          };
        }),
      ),
    ),
  );
};

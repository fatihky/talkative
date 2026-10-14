/*
 * attachments — the client half of an upload: mint the id, classify, POST.
 *
 * Business logic:
 * - Client-only, called by the composer (paste/drop/pick) and the stage's
 *   quick actions; the bytes go to POST /api/attachments.
 * - The id is minted here with uuid() and is the id the server stores the
 *   file under, so a message can reference its attachment before — and
 *   even if — the upload finishes.
 * - kind is 'image' for any mime starting with image/, else 'file'; name
 *   falls back to 'upload', bytes and mime come straight off the File.
 * - Files upload in parallel and each resolves to the metadata it was
 *   built with: the response body is ignored, so what the composer shows
 *   is exactly what the message will carry.
 * - A failed upload still returns that metadata instead of throwing, so a
 *   storage outage never blocks the composer. The server owns the real
 *   limits (20MB images, 10MB everything else) and generation reads
 *   attachments by id, so a missing row just contributes nothing.
 * - scope 'chat' is recorded on the attachment (the tray badges it as chat
 *   context); the default 'message' writes no scope field at all.
 */
import { uploadAttachment } from './api';
import { uuid } from './storage';
import type { Attachment } from '../types';

/* build a file/image attachment and upload its bytes; resolves once stored */
export async function attachFiles(
  files: File[],
  scope: 'message' | 'chat' = 'message',
): Promise<Attachment[]> {
  const items = await Promise.all(
    files.map(async (f): Promise<Attachment> => {
      const attachment: Attachment = {
        id: uuid(),
        kind: f.type.startsWith('image/') ? 'image' : 'file',
        name: f.name || 'upload',
        bytes: f.size,
        mime: f.type,
        ...(scope === 'chat' ? { scope: 'chat' as const } : {}),
      };
      try {
        return await uploadAttachment(attachment, f);
      } catch {
        /* keep the metadata so the composer isn't blocked if storage is down */
        return attachment;
      }
    }),
  );
  return items;
}

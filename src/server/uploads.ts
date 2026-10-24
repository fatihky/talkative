/*
 * server/uploads — filesystem storage for binary (image) uploads.
 *
 * Business logic:
 * - images never go into postgres: they live at
 *   $UPLOADS_DIR/<userId>/<attachmentId>, one directory per user, with
 *   UPLOADS_DIR defaulting to `uploads/` so a docker deployment can back it
 *   with a named volume.
 * - both segments are matched against SEGMENT ([A-Za-z0-9_-]+) before they
 *   are joined, so a caller-supplied id can't escape the directory. the
 *   layout is also the ownership boundary: every function takes the
 *   session's userId and only ever reads or writes underneath it.
 * - saveUpload creates the per-user directory on demand and overwrites, so
 *   re-uploading under the same client-minted attachment id is idempotent.
 * - readUpload returns null instead of throwing when a file is missing or
 *   unreadable: a lost image degrades to no dataUrl while a prompt is built
 *   and to a 404 at the download route, never to a failed generation.
 * - deleteUpload ignores a file that is already gone, then tries rmdir on
 *   the parent, which only succeeds once it is empty — no stray per-user
 *   directories left behind, and no error while other uploads remain.
 * - listUploads walks the two levels and yields (userId, id) pairs, reading
 *   an unreadable directory as empty; `pnpm uploads:gc` uses it to collect
 *   files whose attachment row is gone, e.g. after a user was deleted.
 */
import {
  mkdir,
  readdir,
  readFile,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

/*
 * binary uploads (images) live on the filesystem, not in postgres. the directory is
 * configurable so docker-based deployments can back it with a named volume while
 * plain node deployments fall back to a local `uploads/` directory.
 */

const DEFAULT_DIR = 'uploads';

/* both path segments are server-controlled ids; reject anything that could escape */
const SEGMENT = /^[A-Za-z0-9_-]+$/;

export const uploadsDir = (): string =>
  process.env.UPLOADS_DIR?.trim() || DEFAULT_DIR;

const filePath = (userId: string, id: string): string => {
  if (!SEGMENT.test(userId) || !SEGMENT.test(id))
    throw new Error('invalid upload path segment');
  return path.join(uploadsDir(), userId, id);
};

export async function saveUpload(
  userId: string,
  id: string,
  data: Uint8Array,
): Promise<void> {
  const p = filePath(userId, id);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, data);
}

export async function readUpload(
  userId: string,
  id: string,
): Promise<Uint8Array | null> {
  try {
    return await readFile(filePath(userId, id));
  } catch {
    return null;
  }
}

export async function deleteUpload(userId: string, id: string): Promise<void> {
  const p = filePath(userId, id);
  try {
    await unlink(p);
  } catch {
    /* already gone */
    return;
  }
  /* leave no empty per-user directory behind; rmdir fails while files remain */
  try {
    await rmdir(path.dirname(p));
  } catch {
    /* still holds other uploads */
  }
}

/** every upload on disk as a (userId, id) pair; an unreadable directory reads as empty */
export async function listUploads(): Promise<{ userId: string; id: string }[]> {
  const out: { userId: string; id: string }[] = [];
  const users = await readdir(uploadsDir(), { withFileTypes: true }).catch(
    () => [],
  );
  for (const u of users) {
    if (!u.isDirectory()) continue;
    const files = await readdir(path.join(uploadsDir(), u.name), {
      withFileTypes: true,
    }).catch(() => []);
    for (const f of files)
      if (f.isFile()) out.push({ userId: u.name, id: f.name });
  }
  return out;
}

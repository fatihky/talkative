/*
 * server/artifacts — validation and mapping for published artifacts.
 *
 * Business logic:
 * - an artifact otherwise exists only as an `artifact` tool call's `raw`
 *   along a branch; publishing freezes one version into a row of its own,
 *   so the public page keeps rendering after the chat is edited or the
 *   branch is deleted.
 * - slugify normalizes the model-chosen artifactId to lowercase url-safe
 *   text capped at SLUG_MAX (64). the POST route keys on (userId,
 *   artifactId), so re-publishing updates that row and the link stays put.
 * - the share url is /a/<id>, the row's own integer identity id — the same
 *   id the api paths take, so there is no slug column beside it and no
 *   translation between the two.
 * - toArtifactDto ships the frozen content and version but no userId;
 *   chatTitle is filled in by callers through chatTitles(), which batches
 *   one query for a whole list so rows can link back to their source chat.
 * - leafId is the branch tip at publish time, kept so the owner can reopen
 *   the exact version, while chatId/messageId/callId are loose references:
 *   deleting the source chat leaves the published artifact alone.
 * - parseArtifactCreate requires artifactId, title and content, restricts
 *   kind to ARTIFACT_KINDS, floors version at 1, and keeps the source ids
 *   only when non-empty — an artifact can be published with no provenance.
 * - parseArtifactPatch accepts `published` alone: unpublishing kills the
 *   link without deleting the row, and publishing again revives the same
 *   url. an absent field is a no-op patch, a non-boolean throws
 *   ValidationError, which handle() turns into a 400.
 * - scoping lives in the routes: the list reads only the user's published
 *   rows, patch and delete filter by (id, userId), so a foreign id answers
 *   artifactNotFound(). parseArtifactId gates the :id path first: ids are
 *   integers, and anything else is a 404 without touching the db.
 */
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db';
import type { ArtifactRow } from '../db/schema';
import { artifacts, chats } from '../db/schema';
import { ARTIFACT_KINDS, type ArtifactKind } from '../lib/artifacts';
import type { PublicArtifact } from '../types';
import { ValidationError } from './providers';

export const SLUG_MAX = 64;

/* model-chosen ids are loose; keep them url-safe */
export const slugify = (v: unknown) =>
  (typeof v === 'string' ? v : '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX);

export const toArtifactDto = (
  row: ArtifactRow,
  chatTitle?: string | undefined,
): PublicArtifact => ({
  id: row.id,
  artifactId: row.artifactId,
  title: row.title,
  kind: row.kind as ArtifactKind,
  ...(row.language ? { language: row.language } : {}),
  content: row.content,
  version: row.version,
  published: row.published,
  ...(row.chatId ? { chatId: row.chatId } : {}),
  ...(chatTitle ? { chatTitle } : {}),
  ...(row.leafId ? { leafId: row.leafId } : {}),
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

/** titles for the chats behind a set of artifacts, so rows can link usefully */
export const chatTitles = async (
  db: Db,
  chatIds: (string | null)[],
): Promise<Map<string, string>> => {
  const ids = [...new Set(chatIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: chats.id, title: chats.title })
    .from(chats)
    .where(inArray(chats.id, ids));
  return new Map(rows.map((r) => [r.id, r.title]));
};

export const artifactNotFound = () =>
  Response.json({ error: 'artifact not found' }, { status: 404 });

/* ids are the table's integer identity; a path that isn't a positive integer
   matches no row, so callers answer artifactNotFound() before querying */
export const parseArtifactId = (v: unknown): number | null => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/* same shape the artifact tool writes into a call's `raw` */
export type ArtifactInput = {
  artifactId: string;
  title: string;
  kind: ArtifactKind;
  language?: string | undefined;
  content: string;
  version: number;
  chatId?: string | undefined;
  messageId?: string | undefined;
  callId?: string | undefined;
  leafId?: string | undefined;
};

const str = (v: unknown) => (typeof v === 'string' ? v : '');

export const parseArtifactCreate = (body: unknown): ArtifactInput => {
  const b = (body ?? {}) as Record<string, unknown>;
  const artifactId = slugify(b.artifactId);
  if (!artifactId) throw new ValidationError('artifactId is required');
  const title = str(b.title).trim();
  if (!title) throw new ValidationError('title is required');
  const kind = b.kind as ArtifactKind;
  if (!ARTIFACT_KINDS.includes(kind))
    throw new ValidationError(
      `kind must be one of ${ARTIFACT_KINDS.join(', ')}`,
    );
  const content = str(b.content);
  if (!content) throw new ValidationError('content is required');
  const language = str(b.language).trim();
  const version =
    typeof b.version === 'number' && Number.isFinite(b.version)
      ? Math.max(1, Math.floor(b.version))
      : 1;
  return {
    artifactId,
    title,
    kind,
    ...(language ? { language } : {}),
    content,
    version,
    ...(str(b.chatId) ? { chatId: str(b.chatId) } : {}),
    ...(str(b.messageId) ? { messageId: str(b.messageId) } : {}),
    ...(str(b.callId) ? { callId: str(b.callId) } : {}),
    ...(str(b.leafId) ? { leafId: str(b.leafId) } : {}),
  };
};

export const parseArtifactPatch = (body: unknown) => {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.published === undefined) return {};
  if (typeof b.published !== 'boolean')
    throw new ValidationError('published must be a boolean');
  return { published: b.published };
};

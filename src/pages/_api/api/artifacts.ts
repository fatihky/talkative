/*
 * artifacts — GET/POST /api/artifacts — the caller's published
 * artifacts, and the publish action behind the public /a/<id> links.
 *
 * Business logic:
 * - auth via handle() (401 without a session); both verbs are scoped
 *   by userId, so nobody else's artifact is read or written. No admin
 *   path — publishing is a per-user feature (17ed2a3).
 * - GET lists published rows only, newest first, with each source
 *   chat's title attached through chatTitles() so the settings list
 *   can link back to /c/<chatId>?leaf=<leafId>. Artifacts are private
 *   until published, so this shows share links alone (368d43a).
 * - POST is the publish action. parseArtifactCreate slugifies the
 *   tool-chosen artifactId (url-safe, ≤64), requires title and
 *   content, restricts kind to ARTIFACT_KINDS and floors version at
 *   1; any miss is a ValidationError → 400, and a body that isn't
 *   JSON is a 400 too (handle maps SyntaxError). There is no 404 on
 *   this route — it's a collection.
 * - upsert on (userId, artifactId): an existing row is updated in
 *   place, keeping its integer primary key and therefore the share
 *   url stable across re-publishes (200); a first publish inserts
 *   (201). Both paths force published: true, because reaching this
 *   endpoint *is* the publish decision.
 * - the stored content is a frozen snapshot of one version — later
 *   edits to the chat never change what the public link serves.
 * - language is nulled on update when the input omits it, so a
 *   re-publish as another kind can't keep a stale one.
 * - no side effects to keep in sync: chatId/messageId/callId/leafId
 *   are loose text, so deleting the source chat leaves the artifact
 *   and its link alone, and artifacts carry no uploads.
 * - a vanished insert/update throws → 500 'internal error'.
 */
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../../db';
import { artifacts } from '../../../db/schema';
import {
  chatTitles,
  parseArtifactCreate,
  toArtifactDto,
} from '../../../server/artifacts';
import { handle } from '../../../server/providers';

/* GET /api/artifacts — the user's published artifacts, newest first */
export const GET = () =>
  handle(async (userId) => {
    const db = getDb();
    const rows = await db
      .select()
      .from(artifacts)
      .where(
        and(eq(artifacts.userId, userId), eq(artifacts.published, true)),
      )
      .orderBy(desc(artifacts.createdAt));
    const titles = await chatTitles(
      db,
      rows.map((r) => r.chatId),
    );
    return Response.json(
      rows.map((r) => toArtifactDto(r, r.chatId ? titles.get(r.chatId) : undefined)),
    );
  });

/* POST /api/artifacts — publish one frozen version; re-publishing the same
   artifact id updates that row (same id, same /a/<id> url) */
export const POST = (req: Request) =>
  handle(async (userId) => {
    const db = getDb();
    const input = parseArtifactCreate(await req.json());
    const [existing] = await db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.userId, userId),
          eq(artifacts.artifactId, input.artifactId),
        ),
      )
      .limit(1);

    const { artifactId, title, kind, language, content, version, ...source } =
      input;

    if (existing) {
      const [updated] = await db
        .update(artifacts)
        .set({
          title,
          kind,
          ...(language ? { language } : { language: null }),
          content,
          version,
          published: true,
          ...source,
        })
        .where(eq(artifacts.id, existing.id))
        .returning();
      if (!updated) throw new Error('update failed');
      return Response.json(
        toArtifactDto(updated, await titleFor(db, updated.chatId)),
      );
    }

    const [row] = await db
      .insert(artifacts)
      .values({
        userId,
        artifactId,
        title,
        kind,
        ...(language ? { language } : {}),
        content,
        version,
        /* this endpoint is the publish action: freeze it as public */
        published: true,
        ...source,
      })
      .returning();
    if (!row) throw new Error('insert failed');
    return Response.json(toArtifactDto(row, await titleFor(db, row.chatId)), {
      status: 201,
    });
  });

const titleFor = async (
  db: ReturnType<typeof getDb>,
  chatId: string | null,
) => {
  if (!chatId) return undefined;
  const titles = await chatTitles(db, [chatId]);
  return titles.get(chatId);
};

/*
 * artifacts/[id] — PATCH/DELETE /api/artifacts/:id — take a published
 * artifact offline, or drop it for good.
 *
 * Business logic:
 * - auth via handle(); both writes are scoped by (id, userId) inside
 *   the WHERE clause, so a foreign artifact matches nothing and
 *   answers the same artifactNotFound() 404 as a missing one — never
 *   403, no existence leak.
 * - :id is gated by parseArtifactId() before any query: ids are the
 *   table's integer identity, so a non-numeric path answers 404 straight
 *   away instead of hitting Postgres with a type error.
 * - PATCH accepts `published` alone (parseArtifactPatch): false hides
 *   /a/<id> without deleting the row, true revives the same url. A
 *   non-boolean is a 400; a body without `published` is an empty
 *   patch, which the update rejects → 500 rather than 400.
 * - the PATCH response refills chatTitle through chatTitles() so the
 *   caller's list row stays complete without a second request.
 * - DELETE answers 204 with no body when a row went, and 404 when the
 *   delete matched nothing (missing or foreign id). The frozen
 *   snapshot is gone, so the public page falls back to its
 *   "Artifact not found" panel.
 * - nothing else references artifacts and they carry no uploads, so
 *   there is no pruneAttachments()-style cleanup to keep in sync
 *   here; deleting the source chat doesn't touch these rows either.
 */
import { and, eq } from 'drizzle-orm';
import type { ApiContext } from 'waku/router';
import { getDb } from '../../../../db';
import { artifacts } from '../../../../db/schema';
import {
  artifactNotFound,
  chatTitles,
  parseArtifactId,
  parseArtifactPatch,
  toArtifactDto,
} from '../../../../server/artifacts';
import { handle } from '../../../../server/providers';

type Ctx = ApiContext<'/api/artifacts/[id]'>;

/* PATCH /api/artifacts/:id — currently just publish/unpublish */
export const PATCH = (req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    const id = parseArtifactId(params.id);
    if (id === null) return artifactNotFound();
    const patch = parseArtifactPatch(await req.json());
    const db = getDb();
    const [updated] = await db
      .update(artifacts)
      .set(patch)
      .where(and(eq(artifacts.id, id), eq(artifacts.userId, userId)))
      .returning();
    if (!updated) return artifactNotFound();
    const titles = updated.chatId
      ? await chatTitles(db, [updated.chatId])
      : new Map<string, string>();
    return Response.json(
      toArtifactDto(
        updated,
        updated.chatId ? titles.get(updated.chatId) : undefined,
      ),
    );
  });

export const DELETE = (_req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    const id = parseArtifactId(params.id);
    if (id === null) return artifactNotFound();
    const result = await getDb()
      .delete(artifacts)
      .where(and(eq(artifacts.id, id), eq(artifacts.userId, userId)))
      .returning({ id: artifacts.id });
    return result.length > 0
      ? new Response(null, { status: 204 })
      : artifactNotFound();
  });

/*
 * DecisionItem — PATCH/DELETE /api/decisions/:id — rename or remove one run.
 *
 * Business logic:
 * - auth via handle(); :id must be a uuid, else 404 (decisionNotFound) — a
 *   malformed id can't match a row anyway.
 * - PATCH takes only the title (parseDecisionPatch: non-empty, ≤255 chars).
 *   Re-evaluating a run is POST /api/decisions with its id, not a patch: the
 *   questions, evidence and answers always move together.
 * - ownership lives in the WHERE clause (id AND userId) for both verbs, so a
 *   foreign run matches zero rows and reads as 404 — the same response as a
 *   missing one, no existence leak.
 * - DELETE removes the row and nothing else: a run owns no uploads and no
 *   messages reference it, so there is no cascade and no attachment pruning.
 * - PATCH returns the updated DTO; DELETE returns 204 on success.
 */
import { and, eq } from 'drizzle-orm';
import type { ApiContext } from 'waku/router';
import { getDb } from '../../../../db';
import { decisions } from '../../../../db/schema';
import { isUuid } from '../../../../server/chats';
import {
  decisionNotFound,
  parseDecisionPatch,
  toDecisionDto,
} from '../../../../server/decisions';
import { handle } from '../../../../server/providers';

type Ctx = ApiContext<'/api/decisions/[id]'>;

/* PATCH /api/decisions/:id — rename the run */
export const PATCH = (req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return decisionNotFound();
    const patch = parseDecisionPatch(await req.json());
    const [row] = await getDb()
      .update(decisions)
      .set(patch)
      .where(and(eq(decisions.id, params.id), eq(decisions.userId, userId)))
      .returning();
    if (!row) return decisionNotFound();
    return Response.json(toDecisionDto(row));
  });

export const DELETE = (_req: Request, { params }: Ctx) =>
  handle(async (userId) => {
    if (!isUuid(params.id)) return decisionNotFound();
    const deleted = await getDb()
      .delete(decisions)
      .where(and(eq(decisions.id, params.id), eq(decisions.userId, userId)))
      .returning({ id: decisions.id });
    if (deleted.length === 0) return decisionNotFound();
    return new Response(null, { status: 204 });
  });

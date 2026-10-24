/*
 * Decisions — GET/POST /api/decisions — list the user's runs, and evaluate
 * one against its provider.
 *
 * Business logic:
 * - auth via handle() for both verbs; every read and write is scoped by
 *   userId, so decision runs are strictly per-user and there is no admin
 *   variant.
 * - GET returns the newest 200 as DTOs — the cap keeps the /decisions list
 *   bounded, and a run carries its whole question set and answers.
 * - POST is the run itself: parse the body into the canonical shape
 *   (server/decisions.ts), resolve the namespaced modelId to one of the
 *   caller's connections, and refuse a demo-catalog model, a missing or
 *   disabled connection, and a compatibility with no endpoint for the model's
 *   kind (ollama for /decisions, bifrost/openai for System One) as a 400
 *   before anything is stored.
 * - the run's `kind` is chosen from the picked model's catalog kind (a
 *   systemone model routes to /systemone, anything else to /decisions); a
 *   re-run whose model no longer resolves keeps the kind it ran with.
 * - the row is written *before* the upstream call, so a failure still leaves
 *   the questions and the evidence behind: a client-minted id the caller
 *   doesn't own yet inserts, an id they do own re-runs that row (clearing the
 *   previous attempt's answers), and an id somebody else holds is rejected
 *   rather than overwritten.
 * - an upstream failure is recorded on the row and answered as 200 with the
 *   DTO's `error` set — the request did what it could, and the client shows
 *   the failure beside the run instead of losing it. a ValidationError still
 *   escapes as a 400.
 * - success stores the normalized answers, usage and latency, clears any
 *   earlier error, and returns the stored row's DTO.
 * - the stored key is never returned: the connection's sealed api key is
 *   opened inside runDecision only.
 */
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../../db';
import type { DecisionRow } from '../../../db/schema';
import { decisions } from '../../../db/schema';
import { getCatalog } from '../../../server/catalog';
import {
  decisionIdTaken,
  deriveTitle,
  findDecision,
  listDecisions,
  parseDecisionRun,
  runDecision,
  supportsDecisions,
  supportsSystemOne,
  toDecisionDto,
} from '../../../server/decisions';
import { parseModelId } from '../../../server/model-id';
import {
  findConnection,
  handle,
  ValidationError,
} from '../../../server/providers';
import type { DecisionKind } from '../../../types';

/* GET /api/decisions — the caller's runs, newest first */
export const GET = () =>
  handle(async (userId) => {
    const rows = await listDecisions(getDb(), userId);
    return Response.json(rows.map(toDecisionDto));
  });

/* POST /api/decisions — store the run and evaluate it; 200 with `error` set when upstream failed */
export const POST = (req: Request) =>
  handle(async (userId) => {
    const input = parseDecisionRun(await req.json());
    const parsed = parseModelId(input.modelId);
    if (!parsed)
      throw new ValidationError('modelId must be a provider model id');
    const conn = await findConnection(userId, parsed.connectionId);
    if (!conn) throw new ValidationError('provider not found');
    if (!conn.enabled) throw new ValidationError(`${conn.name} is disabled`);

    const db = getDb();
    const existing = input.id ? await findDecision(db, userId, input.id) : null;
    /* an id the caller doesn't own may still be somebody else's primary key */
    if (input.id && !existing && (await decisionIdTaken(db, input.id)))
      throw new ValidationError('decision id already exists');

    /* the endpoint is chosen by the picked model's kind; a re-run whose model is
       no longer in the catalog keeps the kind it ran with */
    const catalog = await getCatalog(conn);
    const model = catalog.items.find((m) => m.id === input.modelId);
    const kind: DecisionKind =
      model?.kind === 'systemone'
        ? 'systemone'
        : (existing?.kind ?? 'decision');
    const supported =
      kind === 'systemone' ? supportsSystemOne : supportsDecisions;
    if (!supported(conn.compatibility))
      throw new ValidationError(
        `${conn.name} does not support ${
          kind === 'systemone' ? 'System One' : 'decisions'
        }`,
      );

    /* a re-run keeps its title (it may have been renamed); a new one is derived */
    const title =
      input.title ??
      existing?.title ??
      deriveTitle(input.input, input.questions);
    const attempt = {
      kind,
      modelId: input.modelId,
      title,
      input: input.input,
      questions: input.questions,
    };

    let row: DecisionRow;
    if (existing) {
      const [updated] = await db
        .update(decisions)
        /* the previous attempt's outcome is dropped: a row is its latest run */
        .set({
          ...attempt,
          answers: null,
          error: null,
          usage: null,
          latencyMs: null,
        })
        .where(and(eq(decisions.id, existing.id), eq(decisions.userId, userId)))
        .returning();
      if (!updated) throw new Error('update failed');
      row = updated;
    } else {
      const [inserted] = await db
        .insert(decisions)
        .values({
          ...(input.id ? { id: input.id } : {}),
          ...attempt,
          userId,
        })
        .returning();
      if (!inserted) throw new Error('insert failed');
      row = inserted;
    }

    try {
      const outcome = await runDecision(
        conn,
        {
          model: parsed.remoteId,
          input: input.input,
          questions: input.questions,
        },
        { kind },
      );
      const [done] = await db
        .update(decisions)
        .set({
          answers: outcome.answers,
          error: null,
          ...(outcome.usage ? { usage: outcome.usage } : { usage: null }),
          latencyMs: outcome.latencyMs,
        })
        .where(eq(decisions.id, row.id))
        .returning();
      return Response.json(toDecisionDto(done ?? row));
    } catch (e) {
      if (e instanceof ValidationError) throw e;
      const error = e instanceof Error ? e.message : String(e);
      console.warn(`[decisions] run ${row.id} failed: ${error}`);
      const [failed] = await db
        .update(decisions)
        .set({ error })
        .where(eq(decisions.id, row.id))
        .returning();
      return Response.json(toDecisionDto(failed ?? row));
    }
  });

/*
 * tool-preferences — per-user tool toggles, providers, and tuning.
 *
 * Business logic:
 * - Only tools a user has touched get a row; everything else is filled
 *   client-side from the built-in defaults, so the table stays sparse and
 *   "absent" always means "use the default."
 * - loadToolPreferences folds a user's rows into four maps — grants
 *   (enabled), providers, counts (resultCount), concurrency — omitting any
 *   null column so an unset value is indistinguishable from no row.
 * - parseToolPreferences validates a PATCH body hard: every tool id must
 *   exist in TOOLS, a grant must be boolean, a provider must be one the
 *   tool declares, and counts/concurrency must be integers; anything else
 *   throws ValidationError.
 * - saveToolPreferences upserts per tool: an existing row only gets the
 *   fields present in the patch, while a new row seeds `enabled` from
 *   DEFAULT_GRANTS so a provider-only patch never flips the grant.
 * - The (userId, toolId) primary key keeps preferences strictly per user,
 *   one row per tool.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../db';
import { toolPreferences } from '../db/schema';
import { DEFAULT_GRANTS, TOOLS } from '../lib/tools';
import type { ToolPreferences } from '../types';
import { ValidationError } from './providers';

/* only tools the user has touched have a row; the client fills the rest from defaults */
export const loadToolPreferences = async (
  userId: string,
): Promise<ToolPreferences> => {
  const rows = await getDb()
    .select()
    .from(toolPreferences)
    .where(eq(toolPreferences.userId, userId));
  const out: ToolPreferences = { grants: {}, providers: {}, counts: {}, concurrency: {} };
  for (const r of rows) {
    out.grants[r.toolId] = r.enabled;
    if (r.provider) out.providers[r.toolId] = r.provider;
    if (r.resultCount !== null) out.counts[r.toolId] = r.resultCount;
    if (r.concurrency !== null) out.concurrency[r.toolId] = r.concurrency;
  }
  return out;
};

export const parseToolPreferences = (body: unknown): ToolPreferences => {
  const b = (body ?? {}) as Record<string, unknown>;
  const out: ToolPreferences = { grants: {}, providers: {}, counts: {}, concurrency: {} };
  const grants = (b.grants ?? {}) as Record<string, unknown>;
  const providers = (b.providers ?? {}) as Record<string, unknown>;
  const counts = (b.counts ?? {}) as Record<string, unknown>;
  const concurrency = (b.concurrency ?? {}) as Record<string, unknown>;
  for (const [id, on] of Object.entries(grants)) {
    if (!TOOLS.some((t) => t.id === id))
      throw new ValidationError(`unknown tool: ${id}`);
    if (typeof on !== 'boolean')
      throw new ValidationError(`grant for ${id} must be a boolean`);
    out.grants[id] = on;
  }
  for (const [id, provider] of Object.entries(providers)) {
    const tool = TOOLS.find((t) => t.id === id);
    if (!tool) throw new ValidationError(`unknown tool: ${id}`);
    if (typeof provider !== 'string' || !tool.providers?.includes(provider))
      throw new ValidationError(`unknown provider for ${id}: ${provider}`);
    out.providers[id] = provider;
  }
  for (const [id, count] of Object.entries(counts)) {
    if (!TOOLS.some((t) => t.id === id))
      throw new ValidationError(`unknown tool: ${id}`);
    if (typeof count !== 'number' || !Number.isInteger(count))
      throw new ValidationError(`count for ${id} must be an integer`);
    out.counts[id] = count;
  }
  for (const [id, n] of Object.entries(concurrency)) {
    if (!TOOLS.some((t) => t.id === id))
      throw new ValidationError(`unknown tool: ${id}`);
    if (typeof n !== 'number' || !Number.isInteger(n))
      throw new ValidationError(`concurrency for ${id} must be an integer`);
    out.concurrency[id] = n;
  }
  return out;
};

export const saveToolPreferences = async (
  userId: string,
  input: ToolPreferences,
) => {
  const db = getDb();
  const ids = [
    ...new Set([
      ...Object.keys(input.grants),
      ...Object.keys(input.providers),
      ...Object.keys(input.counts),
      ...Object.keys(input.concurrency),
    ]),
  ];
  const rows = ids.length
    ? await db
        .select()
        .from(toolPreferences)
        .where(
          and(
            eq(toolPreferences.userId, userId),
            inArray(toolPreferences.toolId, ids),
          ),
        )
    : [];
  for (const toolId of ids) {
    const existing = rows.find((r) => r.toolId === toolId);
    const on = input.grants[toolId];
    const provider = input.providers[toolId];
    const count = input.counts[toolId];
    const concurrency = input.concurrency[toolId];
    if (existing) {
      const updates: Record<string, unknown> = {};
      if (on !== undefined) updates.enabled = on;
      if (provider !== undefined) updates.provider = provider;
      if (count !== undefined) updates.resultCount = count;
      if (concurrency !== undefined) updates.concurrency = concurrency;
      if (Object.keys(updates).length > 0) {
        await db
          .update(toolPreferences)
          .set(updates)
          .where(
            and(
              eq(toolPreferences.userId, userId),
              eq(toolPreferences.toolId, toolId),
            ),
          );
      }
    } else {
      /* a provider-only patch shouldn't flip the grant, so new rows start from the default */
      await db.insert(toolPreferences).values({
        userId,
        toolId,
        enabled: on ?? DEFAULT_GRANTS[toolId] ?? false,
        provider: provider ?? null,
        resultCount: count ?? null,
        concurrency: concurrency ?? null,
      });
    }
  }
};
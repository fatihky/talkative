/*
 * Models — model picking for server-side background jobs; chat runs
 * address the exact model id chosen in the composer instead.
 *
 * Business logic:
 * - firstEnabledModel walks the user's enabled connections in
 *   creation order and returns the first catalog item not marked
 *   `error` (stale is acceptable) — background labeling shouldn't
 *   need a dedicated model pick.
 * - only `kind: 'llm'` (or a model carrying no kind) qualifies:
 *   systemone/decision models answer /systemone and /decisions, not
 *   chat completions, so picking one fails upstream (ollama's
 *   `"<model>" does not support chat`); embedding models can't chat
 *   either. such models are skipped, not fatal.
 * - each catalog is consulted via getCatalog, so the pick rides the
 *   redis cache and only hits upstream when a list has gone stale.
 * - disabled connections are skipped entirely; a connection whose
 *   catalog failed or came back empty falls through to the next.
 * - null means nothing servable exists (no enabled providers, or
 *   every fetch failed); callers like classify.ts treat that as
 *   "skip the job silently" rather than an error.
 */
import type { Model } from '../types';
import { getCatalog } from './catalog';
import { listConnections } from './providers';

/* background jobs speak chat completions, so only plain llm models qualify */
const canChat = (m: Model): boolean => m.kind === undefined || m.kind === 'llm';

/* the first chat model a user's enabled connections can serve; used for background jobs like classification */
export const firstEnabledModel = async (
  userId: string,
): Promise<Model | null> => {
  const conns = (await listConnections(userId)).filter((c) => c.enabled);
  for (const conn of conns) {
    const entry = await getCatalog(conn);
    const found = entry.items.find((m) => m.status !== 'error' && canChat(m));
    if (found) return found;
  }
  return null;
};

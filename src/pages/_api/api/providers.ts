/*
 * providers — GET/POST /api/providers — list and create the caller's
 * own LLM provider connections.
 *
 * Business logic:
 * - Session-only via `handle`, and providers are per-account config:
 *   the read (listConnections) and the insert both carry the session
 *   user's id, so nothing here is shared or instance-wide.
 * - GET answers with the caller's connections oldest-first (createdAt
 *   asc), each through toDto — the one serialization boundary, which
 *   reports `hasApiKey` and never the stored value.
 * - POST validates with parseInput: name required, compatibility one of
 *   the five known flavours, baseUrl a parseable http(s) URL that gets
 *   normalized per compatibility, apiKey an optional string that is
 *   trimmed and turned into null when blank. A violation throws
 *   ValidationError, which `handle` maps to 400 (an unparseable body's
 *   SyntaxError is also 400, anything else 500).
 * - The key is sealed with encryptSecret() on the way in, so the column
 *   holds an `enc:<version>:<base64>` envelope — or plaintext when no
 *   keyring is configured, which keeps encryption opt-in. Opening a key
 *   (decryptSecret) happens in catalog/complete/runs only, never here.
 * - Replies 201 with the new connection as toDto: the key is not echoed
 *   back to the client that just sent it, only hasApiKey.
 */
import { getDb } from '../../../db';
import { providerConnections } from '../../../db/schema';
import {
  handle,
  listConnections,
  parseInput,
  toDto,
} from '../../../server/providers';
import { encryptSecret } from '../../../server/secrets';

export const GET = () =>
  handle(async (userId) =>
    Response.json((await listConnections(userId)).map(toDto)),
  );

export const POST = (req: Request) =>
  handle(async (userId) => {
    const input = parseInput(await req.json());
    const [conn] = await getDb()
      .insert(providerConnections)
      .values({
        userId,
        name: input.name,
        baseUrl: input.baseUrl,
        compatibility: input.compatibility,
        apiKey: encryptSecret(input.apiKey ?? null),
      })
      .returning();
    if (!conn) throw new Error('insert failed');
    return Response.json(toDto(conn), { status: 201 });
  });

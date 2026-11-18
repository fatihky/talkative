/*
 * Complete — one non-streaming chat-completions round-trip for small
 * background jobs (currently chat classification), separate from the
 * streaming run engine in runs.ts.
 *
 * Business logic:
 * - every supported compatibility speaks openai chat completions;
 *   only the path differs (openrouter prefixes /api/v1), so one fetch
 *   shape serves all providers.
 * - conn.apiKey arrives sealed and is opened with decryptSecret per
 *   call; the bearer header is sent only when a key exists.
 * - `json: true` requests response_format json_object, which is what
 *   classify.ts relies on to get a parseable object back.
 * - the caller's abort signal wins; otherwise a 20 s default timeout
 *   applies, so a hung background job can't block forever.
 * - every request identifies the app via identity.ts: user-agent
 *   everywhere, openrouter attribution headers on that compatibility.
 * - a non-2xx throws `<connection name> → <status>: <body prefix>` so
 *   upstream failures read by provider in logs; a 200 with no
 *   choices resolves to '' rather than an error.
 */
import type { ProviderConnectionRow } from '../db/schema';
import { OPENROUTER_ATTRIBUTION, USER_AGENT } from './identity';
import { decryptSecret } from './secrets';
import { printLocal, startCompletion } from './telemetry';

/* every supported compatibility speaks openai chat completions */
const COMPLETIONS_PATH: Record<ProviderConnectionRow['compatibility'], string> =
  {
    openai: '/v1/chat/completions',
    openrouter: '/api/v1/chat/completions',
    lmstudio: '/v1/chat/completions',
    ollama: '/v1/chat/completions',
    bifrost: '/v1/chat/completions',
  };

export type CompleteMessage = {
  role: 'system' | 'user';
  content: string;
};

/** one non-streaming round-trip; used for small background jobs like classification */
export async function completeText(
  conn: ProviderConnectionRow,
  model: string,
  messages: CompleteMessage[],
  opts: { json?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const apiKey = decryptSecret(conn.apiKey);
  const reqBody = JSON.stringify({
    model,
    messages,
    stream: false,
    ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
  });
  const span = startCompletion({
    conn,
    model,
    stream: false,
    input: messages,
    json: opts.json,
  });
  try {
    const res = await span.within(() =>
      fetch(`${conn.baseUrl}${COMPLETIONS_PATH[conn.compatibility]}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': USER_AGENT,
          ...(conn.compatibility === 'openrouter'
            ? OPENROUTER_ATTRIBUTION
            : {}),
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: reqBody,
        signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      }),
    );
    if (!res.ok) {
      const full = await res.text().catch(() => '');
      /* the request body holds the conversation: console only, never OTel logs */
      printLocal(
        'error',
        `[complete] ${conn.name} (${model}) → ${res.status}: ${full.slice(0, 4000)}\n[complete] request body: ${reqBody.slice(0, 4000)}`,
      );
      const body = full.slice(0, 300);
      const err = new Error(
        `${conn.name} → ${res.status}${body ? `: ${body}` : ''}`,
      );
      span.fail(err, { status: res.status, responseBody: body });
      throw err;
    }
    const json = (await res.json()) as {
      id?: string;
      model?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        cache_read_input_tokens?: number;
        prompt_cache_hit_tokens?: number;
      };
      choices?: {
        finish_reason?: string | null;
        message?: { content?: string | null };
      }[];
    };
    const content = json.choices?.[0]?.message?.content ?? '';
    const finish = json.choices?.[0]?.finish_reason;
    span.end({
      responseId: json.id,
      responseModel: json.model,
      finishReasons: finish ? [finish] : undefined,
      usage: json.usage
        ? {
            promptTokens: json.usage.prompt_tokens,
            completionTokens: json.usage.completion_tokens,
            cachedTokens:
              json.usage.prompt_cache_hit_tokens ??
              json.usage.cache_read_input_tokens,
          }
        : undefined,
      output: { text: content, calls: undefined },
    });
    return content;
  } catch (e) {
    /* no-op when the span already ended with the http status */
    span.fail(e);
    throw e;
  }
}

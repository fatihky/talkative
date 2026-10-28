<!--
  OpenRouter API reference

  Model list:
    https://openrouter.ai/docs/guides/overview/models.md
  Model list API reference:
    https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.md
  Chat completions:
    https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion.md
  App attribution (rankings, Apps tabs, analytics):
    https://openrouter.ai/docs/app-attribution.md
  System One:
    https://openrouter.ai/docs/api/api-reference/systemone/submit-a-system-one-request.md

  Add more endpoint links here as we document the APIs this provider supports.
-->

# OpenRouter

## Model list

`GET /api/v1/models` — returns text-output models by default.

Query parameters include `output_modalities`, `supported_parameters`, `sort`,
`offset`, `limit`, `use_rss`, free-text `q`, and filters such as `category`,
`input_modalities`, `context`, `arch`, `model_authors`, `providers`,
`min_price`/`max_price`, `min_output_price`/`max_output_price`,
`min_age_days`/`max_age_days`, intelligence/coding/agentic index bounds,
`distillable`, `zdr`, `region`, and tool-success-rate bounds.

### `output_modalities`

Filter models by output capability. When omitted, the endpoint returns
text-output models only — image generators, embedding models and **decision
models** (such as Jev) are _excluded_ and must be requested by their modality
(or `all`) to appear.

| Value           | Description                                                       |
| --------------- | ----------------------------------------------------------------- |
| `text`          | Text output (the default).                                        |
| `image`         | Image generators.                                                 |
| `video`         | Video generators.                                                 |
| `audio`         | Audio output.                                                     |
| `speech`        | Text-to-speech.                                                   |
| `transcription` | Speech-to-text.                                                   |
| `embeddings`    | Embedding models.                                                 |
| `rerank`        | Reranking models.                                                 |
| `decisions`     | Decision models (e.g. Jev) that return typed judgments, not text. |
| `all`           | Every model regardless of modality.                               |

A comma-separated list narrows to those modalities. Decision models are not in
the default text-only list, so fetch them explicitly:

```bash
# decision models only (e.g. Jev)
curl "https://openrouter.ai/api/v1/models?output_modalities=decisions"

# text and decisions
curl "https://openrouter.ai/api/v1/models?output_modalities=text,decisions"
```

### `sort`

Server-side ordering. Values: `pricing-low-to-high`, `pricing-high-to-low`,
`context-high-to-low`, `throughput-high-to-low`, `latency-low-to-high`,
`most-popular` (alias `top-weekly`), `newest`, `intelligence-high-to-low`,
`coding-high-to-low`, `agentic-high-to-low`, `design-arena-elo-high-to-low`.
Models without a score for the chosen dimension sort last.

### Response

```json
{
  "data": [
    /* OpenRouterModel, … */
  ],
  "total_count": 150,
  "links": { "next": "/api/v1/models?offset=500&limit=500" }
}
```

Pagination is opt-in; `links.next` is a ready-to-use URL, `null` on the last page.

### OpenRouterModel

| Field                                                      | Type       | Notes                                                                                         |
| ---------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| `id`                                                       | `string`   | e.g. `"google/gemini-2.5-pro-preview"`.                                                       |
| `canonical_slug`                                           | `string`   | Permanent slug that never changes.                                                            |
| `name`                                                     | `string`   | Human-readable display name.                                                                  |
| `created`                                                  | `number`   | Unix timestamp the model was added.                                                           |
| `description`                                              | `string`   | Capabilities description.                                                                     |
| `context_length`                                           | `number`   | Max context window in tokens.                                                                 |
| `architecture.modality`                                    | `string`   | e.g. `"text->text"`.                                                                          |
| `architecture.tokenizer`                                   | `string`   | Tokenizer family (e.g. `"GPT"`, `"Claude"`, `"Gemini"`).                                      |
| `architecture.instruct_type`                               | `string`   | Instruction format (e.g. `"chatml"`); `null` when N/A.                                        |
| `architecture.input_modalities`                            | `string[]` | e.g. `["file", "image", "text"]`.                                                             |
| `architecture.output_modalities`                           | `string[]` | e.g. `["text"]`; decision models report `["decisions"]`.                                      |
| `pricing`                                                  | `object`   | USD per token/request as strings (`"0"` = free).                                              |
| `pricing.prompt`                                           | `string`   | Cost per input token.                                                                         |
| `pricing.completion`                                       | `string`   | Cost per output token.                                                                        |
| `pricing.internal_reasoning`                               | `string`   | Cost for internal reasoning tokens.                                                           |
| `pricing.input_cache_read`                                 | `string`   | Cost per cached input token read.                                                             |
| `pricing.input_cache_write`                                | `string`   | Cost per cached input token write.                                                            |
| `pricing.request` / `pricing.image` / `pricing.web_search` | `string`   | Per-request, per-image, and per-web-search costs.                                             |
| `pricing.overrides`                                        | `array`    | Conditional pricing overrides (long-context, time-of-day windows).                            |
| `top_provider.is_moderated`                                | `boolean`  | Whether content moderation is applied.                                                        |
| `top_provider.context_length`                              | `number`   | Provider-specific context limit.                                                              |
| `top_provider.max_completion_tokens`                       | `number`   | Ceiling for `max_tokens` (shared with input in the context window).                           |
| `per_request_limits`                                       | `object`   | `{ prompt_tokens, completion_tokens }`; `null` if no limits.                                  |
| `supported_parameters`                                     | `string[]` | `tools`, `reasoning`, `response_format`, `structured_outputs`, etc.                           |
| `default_parameters`                                       | `object`   | Default `temperature`/`top_p`/…; `null` if none.                                              |
| `reasoning`                                                | `object`   | `mandatory`, `default_enabled`, `supported_efforts`, `default_effort`, `supports_max_tokens`. |
| `expiration_date`                                          | `string`   | ISO date the model may be removed by; `null` if not deprecated.                               |
| `benchmarks`                                               | `object`   | Third-party rankings; omitted when no data.                                                   |

### Single model lookup

`GET /api/v1/model/{author}/{slug}` — returns one model's full details as
`{ "data": { …Model } }`. Aliases resolve automatically; catalog variants
(such as `:free`) return their own entry, while routing variants (`:nitro`)
return the base model's entry. Returns `404` for unknown models.

## App attribution

`HTTP-Referer` (required) identifies the app for OpenRouter's rankings,
model "Apps" tabs and analytics; the URL becomes the app's permanent
identifier. `X-OpenRouter-Title` sets the display name (`X-Title` is the
legacy spelling), `X-OpenRouter-Categories` assigns marketplace categories
(comma-separated, max 2 per request, merged up to 10 total, unrecognized
values dropped silently), and `X-OpenRouter-App-Visibility: hidden` keeps a
brand-new app out of public listings. A title alone creates nothing — the
referer is what opens the app page, and localhost URLs also need the title.

Talkative sends these on every openrouter request (chat completions and
model-list fetches):

```http
HTTP-Referer: https://github.com/fatihky/talkative
X-OpenRouter-Title: Talkative
X-OpenRouter-Categories: general-chat,personal-agent
```

## Chat completions

`POST /api/v1/chat/completions` — supports streaming (SSE) and non-streaming.

```bash
curl https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "What is the capital of France?"}
    ]
  }'
```

### Request

| Field                                           | Type                 | Notes                                                                                                                                                                                                                       |
| ----------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`                                         | `string`             | Model id, `provider/model` format.                                                                                                                                                                                          |
| `messages`                                      | `array`              | Required. `system`/`developer`/`user`/`assistant`/`tool` roles.                                                                                                                                                             |
| `models`                                        | `string[]`           | Alternative multi-model routing.                                                                                                                                                                                            |
| `provider`                                      | `object`             | Provider routing preferences.                                                                                                                                                                                               |
| `plugins`                                       | `array`              | `router`, `auto-router`, `auto-beta-router`, `pareto-router`, `fusion`, `switchyard-router`, `jev-router`, `moderation`, `web`, `web-fetch`, `file-parser`, `response-healing`, `context-compression`, `alignment` plugins. |
| `stream`                                        | `boolean`            | Default `false`.                                                                                                                                                                                                            |
| `max_tokens` / `max_completion_tokens`          | `integer`            | `max_tokens` deprecated; some providers enforce a minimum of 16.                                                                                                                                                            |
| `temperature`                                   | `number`             | 0–2.                                                                                                                                                                                                                        |
| `top_p`                                         | `number`             | 0–1.                                                                                                                                                                                                                        |
| `top_k`                                         | `integer`            | Top-K sampling; not all providers.                                                                                                                                                                                          |
| `frequency_penalty` / `presence_penalty`        | `number`             | -2.0–2.0.                                                                                                                                                                                                                   |
| `repetition_penalty`                            | `number`             | 1.0 = no penalty; not all providers.                                                                                                                                                                                        |
| `min_p` / `top_a`                               | `number`             | Provider-specific tail sampling.                                                                                                                                                                                            |
| `stop`                                          | `string \| string[]` | Up to 4 sequences.                                                                                                                                                                                                          |
| `seed`                                          | `integer`            | Deterministic output.                                                                                                                                                                                                       |
| `logit_bias` / `logprobs` / `top_logprobs`      | —                    | Token logit adjustments and log-probs.                                                                                                                                                                                      |
| `tools` / `tool_choice` / `parallel_tool_calls` | —                    | Function calling.                                                                                                                                                                                                           |
| `response_format`                               | `object`             | `json_object` / `json_schema` / grammar / `python` / `text`.                                                                                                                                                                |
| `reasoning` / `reasoning_effort`                | —                    | Reasoning-model controls; `reasoning.summary` (`auto`/`concise`/`detailed`) too. A level the upstream rejects is a 400, not a clamp — `none` in particular fails on models that always reason. |
| `modalities`                                    | `string[]`           | Output modalities: `text`, `image`, `audio`.                                                                                                                                                                                |
| `cache_control`                                 | `object`             | Automatic prompt caching (e.g. `{"type": "ephemeral"}`).                                                                                                                                                                    |
| `deferred_tools`                                | `object`             | Versioned router-level deferred-tool protocol.                                                                                                                                                                              |
| `image_config`                                  | `object`             | Provider-specific image options.                                                                                                                                                                                            |
| `prompt_cache_key` / `prompt_cache_options`     | —                    | Prompt-cache control.                                                                                                                                                                                                       |
| `metadata`                                      | `object`             | Max 16 string pairs (64-char keys, 512-char values).                                                                                                                                                                        |
| `service_tier`                                  | `string`             | `auto`/`default`/`fast`/`flex`/`priority`/`scale`/`ultrafast`.                                                                                                                                                              |
| `stop_server_tools_when`                        | `object`             | Stop condition for server tools.                                                                                                                                                                                            |
| `stream_options`                                | `object`             | `include_usage` etc.                                                                                                                                                                                                        |
| `trace`                                         | `object`             | `trace_id`, span/generation names, custom keys.                                                                                                                                                                             |
| `debug`                                         | `object`             | `echo_upstream_body` (streaming only).                                                                                                                                                                                      |
| `user`                                          | `string`             | Per-end-user identifier; never forwarded raw.                                                                                                                                                                               |
| `session_id`                                    | `string`             | Sticky routing key; max 256 chars.                                                                                                                                                                                          |

### Response (non-streaming)

Standard OpenAI `chat.completion` plus `openrouter_metadata` when the
`X-OpenRouter-Metadata: enabled` header is set (defaults to `disabled`; the
legacy `X-OpenRouter-Experimental-Metadata` header is still accepted), and a
`service_tier` field.

### Response (streaming)

`text/event-stream` of `chat.completion.chunk` events terminated by `[DONE]`;
the chunk is wrapped under a `data` key.

## Decisions (alpha)

`POST /api/alpha/decisions` — submits a Decisions request to the Decisions
router. Alpha endpoint, and **map form only**: questions are an object keyed by
name rather than OpenAI's ordered array, and the evidence field is `state`
rather than `input`.

```bash
curl https://openrouter.ai/api/alpha/decisions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "typesafe/jev-1.13",
    "state": "My checkout page shows a blank screen after I click Pay.",
    "questions": {
      "is_bug": {
        "type": "noul",
        "instructions": "Is the customer reporting a software defect?",
        "criteria": {
          "true": "The customer describes broken or unexpected product behavior.",
          "false": "The customer is asking a question or requesting a feature."
        }
      },
      "team": {
        "type": "choice",
        "instructions": "Which team should own this ticket?",
        "criteria": {
          "payments": "Checkout, billing, or payment processing issues.",
          "frontend": "Rendering, layout, or browser compatibility issues."
        }
      },
      "urgency": {
        "type": "score",
        "instructions": "How urgent is this ticket?",
        "criteria": [
          "Can wait for the next release",
          "Should be fixed this week",
          "Blocking revenue right now"
        ]
      }
    }
  }'
```

### Request

| Field        | Type                        | Notes                                                                                         |
| ------------ | --------------------------- | --------------------------------------------------------------------------------------------- |
| `model`      | `string`                    | Required.                                                                                     |
| `state`      | `string \| object \| array` | Required. The content to evaluate.                                                            |
| `questions`  | `object`                    | Required. Named questions; the key becomes the answer's field name.                           |
| `provider`   | `object`                    | Provider routing preferences, same shape as chat completions.                                 |
| `session_id` | `string`                    | Observability grouping, ≤256 chars; never sent to the provider.                               |
| `trace`      | `object`                    | `trace_id`, `trace_name`, `span_name`, `generation_name`, `parent_span_id`, plus custom keys. |
| `user`       | `string`                    | End-user identifier, ≤256 chars.                                                              |

### Question

| `type`                        | `instructions` | `criteria`                                                                |
| ----------------------------- | -------------- | ------------------------------------------------------------------------- |
| `noul` (OpenAI's `predicate`) | required       | optional `{true, false}` descriptions of the two outcomes                 |
| `choice`                      | required       | required map of `value → description`                                     |
| `score`                       | required       | required ordered array of level descriptions; index 0 is the lowest level |

`instructions` and every `criteria` value may be a plain string or a JSON
object/array of structured guidance.

### Response

```json
{
  "id": "gen-dec-1789738314-X5e5eKGQdvR9rblyX250",
  "model": "typesafe/jev-1.13-20260917",
  "provider": "TypeSafe",
  "answers": {
    "is_bug": { "type": "noul", "noul": 0.96 },
    "team": {
      "type": "choice",
      "choice": "payments",
      "probabilities": { "account": 0, "frontend": 0.16, "payments": 0.84 },
      "confidence": 0.75
    },
    "urgency": {
      "type": "score",
      "score": 1.99,
      "probabilities": { "0": 0, "1": 0.01, "2": 0.99 },
      "legend": {
        "0": "Can wait for the next release",
        "1": "Should be fixed this week",
        "2": "Blocking revenue right now"
      },
      "confidence": 0.99
    }
  },
  "usage": { "input_tokens": 476, "output_tokens": 70, "cost": 0.000019992 }
}
```

`answers` is keyed by question name, `probabilities` is a map (not an array),
a noul answer carries its probability under `noul`, and `usage` reports
`input_tokens`/`output_tokens`/`cost` rather than OpenAI's prompt/completion
names. Failures use OpenRouter's standard `{error: {code, message}}` envelope
(400, 401, 402, 403, 404, 413, 429, 500, 502, 503, 524, 529).

## System One

`POST /api/v1/systemone` — the stable System One endpoint (the alpha
`/api/alpha/decisions` map form, promoted to `/api/v1`). Same request/response
shape as the alpha route above: `state` plus `questions` keyed by name, `noul`/
`choice`/`score` types, and `answers` keyed by name with `noul`/`choice`/`score`
results and `input_tokens`/`output_tokens`/`cost` usage.

Bare System One model ids such as `jev-1.13` and `jev-latest` map onto the
`typesafe/` namespace, so a bare id can be sent in place of `typesafe/jev-1.13`.

```bash
curl https://openrouter.ai/api/v1/systemone \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "typesafe/jev-1.13",
    "state": "I was charged twice.",
    "questions": {
      "angry": {"type": "noul", "instructions": "Is the customer angry?"}
    }
  }'
```

The catalog requests these models with `output_modalities=decisions` and marks
them `kind: "systemone"`.

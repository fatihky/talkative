<!--
  Bifrost API reference

  Model list:
    https://docs.getbifrost.ai/api-reference/models/list-available-models.md
  Chat completions:
    https://docs.getbifrost.ai/api-reference/chat-completions/create-a-chat-completion.md
  Decisions:
    https://docs.getbifrost.ai/api-reference/decisions/evaluate-a-decision.md

  Add more endpoint links here as we document the APIs this provider supports.

  Bifrost is an OpenAI-compatible API gateway. The unified inference API lives
  under `/v1/*`; model ids use the `provider/model` format (e.g. `openai/gpt-4`).
-->

# Bifrost

## Model list

`GET /v1/models` — lists all models from all configured providers (or one, via `provider`).

Query parameters: `provider`, `page_size`, `page_token`.

### Response

```json
{
  "data": [ /* Model, … */ ],
  "next_page_token": "string",
  "extra_fields": { /* BifrostResponseExtraFields */ }
}
```

Pagination uses `next_page_token`; pass it back as `page_token`.

### Model

| Field                                | Type       | Notes                                                                                                          |
| ------------------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `id`                                 | `string`   | `provider/model` format.                                                                                       |
| `canonical_slug`                     | `string`   | Stable slug for the model.                                                                                     |
| `name`                               | `string`   | Human-readable display name.                                                                                   |
| `normalized_name`                    | `string`   | Derived from the Bifrost pricing-catalog base model (e.g. "Claude Sonnet 4.5"); present only for known models. |
| `deployment`                         | `string`   | Deployment identifier.                                                                                         |
| `created`                            | `int64`    | Unix timestamp the model was created.                                                                          |
| `context_length`                     | `integer`  | Max context window.                                                                                            |
| `max_input_tokens`                   | `integer`  | Max input tokens.                                                                                              |
| `max_output_tokens`                  | `integer`  | Max output tokens.                                                                                             |
| `architecture.modality`              | `string`   | e.g. `"text->text"`.                                                                                           |
| `architecture.tokenizer`             | `string`   | Tokenizer family, e.g. `"GPT"`.                                                                                |
| `architecture.instruct_type`         | `string`   | Instruction format, e.g. `"chatml"`.                                                                           |
| `architecture.input_modalities`      | `string[]` | e.g. `["text"]`, `["text", "image"]`.                                                                          |
| `architecture.output_modalities`     | `string[]` | e.g. `["text"]`.                                                                                               |
| `pricing`                            | `object`   | USD per token/request as strings.                                                                              |
| `pricing.prompt`                     | `string`   | Cost per input token.                                                                                          |
| `pricing.completion`                 | `string`   | Cost per output token.                                                                                         |
| `pricing.request`                    | `string`   | Fixed cost per request.                                                                                        |
| `pricing.image`                      | `string`   | Cost per image input.                                                                                          |
| `pricing.web_search`                 | `string`   | Cost per web search.                                                                                           |
| `pricing.internal_reasoning`         | `string`   | Cost for internal reasoning tokens.                                                                            |
| `pricing.input_cache_read`           | `string`   | Cost per cached input token read.                                                                              |
| `pricing.input_cache_write`          | `string`   | Cost per cached input token write.                                                                             |
| `top_provider.is_moderated`          | `boolean`  | Whether content moderation is applied.                                                                         |
| `top_provider.context_length`        | `integer`  | Provider-specific context limit.                                                                               |
| `top_provider.max_completion_tokens` | `integer`  | Max tokens in response.                                                                                        |
| `per_request_limits`                 | `object`   | `{ prompt_tokens, completion_tokens }`.                                                                        |
| `supported_parameters`               | `string[]` | `tools`, `response_format`, `structured_outputs`, etc.                                                         |
| `default_parameters`                 | `object`   | e.g. `{ temperature, top_p, frequency_penalty }`.                                                              |
| `reasoning`                          | `object`   | Reasoning capabilities; fields omitted when the provider does not report them.                                 |
| `reasoning.mandatory`                | `boolean`  | Reasoning is always on.                                                                                        |
| `reasoning.default_enabled`          | `boolean`  | Reasoning on by default.                                                                                       |
| `reasoning.supported_efforts`        | `string[]` | Selectable effort levels; absent when no selectable effort.                                                    |
| `reasoning.default_effort`           | `string`   | Default effort level.                                                                                          |
| `hugging_face_id`                    | `string`   | Hugging Face model id, when applicable.                                                                        |
| `description`                        | `string`   | Model description.                                                                                             |
| `owned_by`                           | `string`   | Model owner.                                                                                                   |
| `supported_methods`                  | `string[]` | e.g. `chat`, `responses`, `decisions`.                                                                         |

## Chat completions

`POST /v1/chat/completions` — creates a completion for the provided messages.
Supports streaming via SSE.

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer $BIFROST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

Auth: `Bearer` (provider key or auth token), `x-api-key`, or `x-bf-vk`
(virtual key `sk-bf-*`).

### Request

Required: `model` (`provider/model` format) and `messages`.

Notable optional fields:

| Field                                           | Type                 | Notes                                                                                                            |
| ----------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `fallbacks`                                     | `string[]`           | Fallback models tried if the primary fails.                                                                      |
| `stream`                                        | `boolean`            | SSE when true.                                                                                                   |
| `temperature`                                   | `number`             | 0–2.                                                                                                             |
| `top_p`                                         | `number`             | 0–1.                                                                                                             |
| `max_completion_tokens`                         | `integer`            | Max output tokens.                                                                                               |
| `frequency_penalty` / `presence_penalty`        | `number`             | -2–2.                                                                                                            |
| `stop`                                          | `string \| string[]` | Up to 4 sequences.                                                                                               |
| `seed`                                          | `integer`            | Deterministic sampling.                                                                                          |
| `logit_bias` / `logprobs` / `top_logprobs`      | —                    | Log-prob controls.                                                                                               |
| `tools` / `tool_choice` / `parallel_tool_calls` | —                    | Function (`function`/`custom`) calling; `tool_choice` also takes `allowed_tools`.                                |
| `response_format`                               | `object`             | Format for the response.                                                                                         |
| `reasoning`                                     | `object`             | `effort` (`none`–`xhigh`), `mode` (`standard`/`pro`), `summary` (`auto`/`concise`/`detailed`), and `max_tokens`. |
| `modalities`                                    | `string[]`           | Output modalities.                                                                                               |
| `prediction`                                    | `object`             | Predicted output (OpenAI only).                                                                                  |
| `web_search_options`                            | `object`             | Web search (OpenAI only).                                                                                        |
| `prompt_cache_key` / `prompt_cache_retention`   | —                    | Prompt-cache control.                                                                                            |
| `metadata`                                      | `object`             | Arbitrary request metadata.                                                                                      |
| `safety_identifier`                             | `string`             | Stable end-user identifier.                                                                                      |
| `service_tier`                                  | `string`             | Service tier to route to.                                                                                        |
| `stream_options`                                | `object`             | `include_usage`, `include_obfuscation`.                                                                          |
| `store`                                         | `boolean`            | Whether to store the completion.                                                                                 |
| `truncation`                                    | `string`             | Truncation behavior.                                                                                             |
| `verbosity`                                     | `string`             | `low`/`medium`/`high`.                                                                                           |
| `user`                                          | `string`             | Per-end-user identifier.                                                                                         |

### Response (non-streaming)

OpenAI-style `chat.completion` with `service_tier`/`system_fingerprint` plus
`extra_fields` (provider, `model_requested`, `model_deployment`, latency, etc.),
and optional `search_results`, `videos`, and `citations` for web-search
providers. `usage` includes token totals (`prompt_tokens_details`,
`completion_tokens_details`), `tool_usage.web_search.num_requests`, and a `cost`
breakdown (`input_tokens_cost`, `output_tokens_cost`, `reasoning_tokens_cost`,
`citation_tokens_cost`, `search_queries_cost`, `request_cost`, `total_cost`).

### Response (streaming)

`text/event-stream` of chunks carrying `delta` (content, reasoning, tool_calls)
and per-chunk `extra_fields.chunk_index`.

## Decisions

`POST /v1/decisions` — asks a list of questions about some input and returns one
typed answer per question, in order, with per-answer confidence and
probabilities. Served by any decision model (Typesafe's jev, Laya, Nimble and
Clef) or by any chat model through structured output, so a `provider/model` that
only speaks chat completions still works.

```bash
curl http://localhost:8080/v1/decisions \
  -H "Authorization: Bearer $BIFROST_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "typesafe/jev-1.13.0",
    "input": "I was charged twice for my order.",
    "questions": [{
      "type": "predicate",
      "name": "billing_issue",
      "instructions": "Is this a billing problem?",
      "criteria": {"true": "Money, invoices or refunds.", "false": "Anything else."}
    }]
  }'
```

### Request

| Field               | Type                                                 | Notes                                                                                                                                          |
| ------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`             | `string`                                             | Required, `provider/model` format.                                                                                                             |
| `input`             | `string \| DecisionInputMessage[] \| object \| null` | Required. A string, messages with `input_text`/`input_image` parts, structured data (passed to Typesafe-based models as their state), or null. |
| `questions`         | `DecisionQuestion[]`                                 | Required, ≥1. Answers follow the same order.                                                                                                   |
| `safety_identifier` | `string`                                             | Stable end-user id, forwarded to providers that accept one (OpenAI).                                                                           |
| `fallbacks`         | `string[]`                                           | Fallback models in `provider/model` format.                                                                                                    |

`DecisionInputMessage` is `{type?: "message", role, content}` with `content` a
string or an array of `{type: "input_text", text}` /
`{type: "input_image", image_url, detail?}` parts (`image_url` is a base64 data
URL or an http(s) URL; `detail` is `low`/`high`/`auto`/`original`).

### Question

| Field          | Type                                         | Notes                                                                                                                                                          |
| -------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`         | `"predicate" \| "choice" \| "score"`         | Required. `predicate` yields the probability a condition is true (Typesafe's `noul`), `choice` one of the choices, `score` a probability-weighted level index. |
| `name`         | `string`                                     | Optional; the answer carries it back (OpenAI sends null for an unnamed question).                                                                              |
| `instructions` | `string \| object \| array`                  | The question; structured data is preserved losslessly for providers that accept it.                                                                            |
| `criteria`     | `{true?, false?}`                            | Predicate only, read by Typesafe-based models.                                                                                                                 |
| `choices`      | `{value: string \| boolean, description?}[]` | Choice only.                                                                                                                                                   |
| `levels`       | `{label, description?}[]`                    | Score only, ordered lowest first.                                                                                                                              |

### Response

| Field          | Type               | Notes                                                                           |
| -------------- | ------------------ | ------------------------------------------------------------------------------- |
| `id`           | `string`           | Unique identifier for the decision response.                                    |
| `model`        | `string`           | Model that performed the decision.                                              |
| `answers`      | `DecisionAnswer[]` | One per question, in question order.                                            |
| `usage`        | `BifrostLLMUsage`  | Token totals plus the `cost` breakdown.                                         |
| `extra_fields` | `object`           | `request_type`, `provider`, `model_requested`, `model_deployment`, `latency`, … |
| `routing`      | `object`           | Laya only: the checkpoint that answered and why.                                |

`DecisionAnswer` carries `type` (the question's type, or `refusal` when the
model declined), `name`, and the type's result: `probability` for a predicate,
`choice` for a choice, `score` plus `legend` (level index → description) for a
score, with `probabilities` (`{value, label?, probability}[]`) and `confidence`
where supplied. Laya adds `answer_confidence`, `action`, `abstention`,
`abstention_threshold` and `low_confidence`.

### Deprecated map form

A request with `state` and questions keyed by name (`{kind: noul|choice|score,
instructions, criteria}`) is still served and answered in kind: `answers` is an
object mapping each question name to `{kind, value, confidence?, probabilities?,
legend?}`. New callers should use the list form above.

### System One

Bifrost exposes no `/v1/systemone` endpoint, so `server/decisions.ts` reports
that compatibility as unsupported for System One runs and `server/catalog.ts`
never marks a model `kind: "systemone"`.

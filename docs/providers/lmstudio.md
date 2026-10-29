<!--
  LM Studio API reference

  Model list:
    https://lmstudio.ai/docs/developer/rest/list.md
  Chat completions:
    https://lmstudio.ai/docs/developer/openai-compat/chat-completions.md
  Decisions:
    https://lmstudio.ai/docs/developer/openai-compat/decisions.md
  System One:
    https://lmstudio.ai/docs/developer/jev-compat/systemone.md
  Model load (a decision model must be loaded before it can answer):
    https://lmstudio.ai/docs/developer/rest/load.md

  Chat completions `model` field (what a custom model's upstream id is sent as):
    https://lmstudio.ai/docs/developer/openai-compat/chat-completions.md

  Add more endpoint links here as we document the APIs this provider supports.
-->

# LM Studio

## Model list

`GET /api/v1/models` — no request parameters.

```bash
curl http://localhost:1234/api/v1/models \
  -H "Authorization: Bearer $LM_API_TOKEN"
```

### Response

```json
{ "models": [ /* LMStudioModel, … */ ] }
```

### LMStudioModel

| Field                               | Type                                 | Notes                                                                                                                     |
| ----------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `type`                              | `"llm" \| "embedding" \| "decision"` | Model kind.                                                                                                               |
| `publisher`                         | `string`                             | Publisher name.                                                                                                           |
| `key`                               | `string`                             | Unique identifier.                                                                                                        |
| `display_name`                      | `string`                             | Human-readable name.                                                                                                      |
| `architecture`                      | `string \| null`                     | e.g. `"llama"`, `"mistral"`. Absent for embedding models.                                                                 |
| `quantization`                      | `object \| null`                     | `{ name: string \| null, bits_per_weight: number \| null }`.                                                              |
| `size_bytes`                        | `number`                             | Model size in bytes.                                                                                                      |
| `params_string`                     | `string \| null`                     | e.g. `"7B"`, `"13B"`.                                                                                                     |
| `loaded_instances`                  | `array`                              | `[{ id, config: { context_length, eval_batch_size, parallel, flash_attention, num_experts, offload_kv_cache_to_gpu } }]`. |
| `max_context_length`                | `number \| null`                     | Max context in tokens; may be null for decision models.                                                                   |
| `format`                            | `"gguf" \| "mlx" \| null`            | Model file format.                                                                                                        |
| `capabilities`                      | `object`                             | Absent for embedding/decision models.                                                                                     |
| `capabilities.vision`               | `boolean`                            | Vision/image input support.                                                                                               |
| `capabilities.trained_for_tool_use` | `boolean`                            | Trained for tool/function calling.                                                                                        |
| `capabilities.reasoning`            | `object`                             | `{ allowed_options: ("off"\|"on"\|"low"\|"medium"\|"high")[], default }`.                                                 |
| `decision_type`                     | `string`                             | Decision model type; only present for decision models when available.                                                     |
| `has_vision_adapter`                | `boolean`                            | Whether the decision model has a vision adapter; only present for decision models.                                        |
| `description`                       | `string \| null`                     | Model description; absent for embedding and decision models.                                                              |
| `variants`                          | `string[]`                           | Quantization variant names (multi-variant models).                                                                        |
| `selected_variant`                  | `string`                             | Currently selected variant.                                                                                               |

## Chat completions

`POST /v1/chat/completions` — OpenAI-compatible. The prompt template is applied
automatically for chat-tuned models.

```bash
curl http://localhost:1234/v1/chat/completions \
  -H "Authorization: Bearer $LM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "model-identifier",
    "messages": [{"role": "user", "content": "Introduce yourself."}],
    "temperature": 0.7
  }'
```

### Supported payload parameters

`model`, `messages`, `temperature`, `top_p`, `top_k`, `max_tokens`, `stream`,
`stop`, `presence_penalty`, `frequency_penalty`, `logit_bias`,
`repeat_penalty`, `seed`.

See the OpenAI chat completions reference for parameter semantics.

## Model load

`POST /api/v1/models/load` — loads an LLM, embedding, or decision model. A
decision model must be loaded before it can serve `/v1/decisions`.

```bash
curl http://localhost:1234/api/v1/models/load \
  -H "Authorization: Bearer $LM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-oss-20b",
    "context_length": 16384,
    "flash_attention": true,
    "echo_load_config": true
  }'
```

### Request

| Field                     | Type      | Notes                                                                  |
| ------------------------- | --------- | ---------------------------------------------------------------------- |
| `model`                   | `string`  | Required. Unique identifier (LLM, embedding, or decision).             |
| `context_length`          | `number`  | Max tokens the model considers.                                        |
| `eval_batch_size`         | `number`  | Input tokens batched per eval step; llama.cpp engine only.             |
| `flash_attention`         | `boolean` | Enable Flash Attention; llama.cpp engine only.                         |
| `num_experts`             | `number`  | Experts used for MoE models; llama.cpp engine only.                    |
| `offload_kv_cache_to_gpu` | `boolean` | Keep KV cache in GPU memory instead of CPU/RAM; llama.cpp engine only. |
| `echo_load_config`        | `boolean` | Echo the final config as `load_config` in the response.                |

### Response

| Field               | Type                                 | Notes                                                             |
| ------------------- | ------------------------------------ | ----------------------------------------------------------------- |
| `type`              | `"llm" \| "embedding" \| "decision"` | Type of the loaded model.                                         |
| `instance_id`       | `string`                             | Identifier for the loaded instance.                               |
| `load_time_seconds` | `number`                             | Time to load in seconds.                                          |
| `status`            | `"loaded"`                           | Load status.                                                      |
| `load_config`       | `object`                             | Present when `echo_load_config` is set; the final applied config. |

## Decisions

`POST /v1/decisions` — OpenAI-compatible decisions (see
`docs/providers/openai.md` for the full request/response shape).

Requires a **loaded decision model** — a model the model list reports as
`type: "decision"` — not a regular chat model. Load it first through
`POST /api/v1/models/load`.

```bash
curl http://localhost:1234/v1/decisions \
  -H "Authorization: Bearer $LM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "model-identifier",
    "input": "I was charged twice.",
    "questions": [
      {"type": "predicate", "name": "angry", "instructions": "Is the customer angry?"}
    ]
  }'
```

The response is OpenAI's `{ "answers": [ … ] }` array: one answer per question,
in question order, each carrying its `name` and the type's result
(`probability` / `choice` / `score`, with `probabilities` and `confidence` where
the model reports them).

Decision models report no `capabilities` and often no `max_context_length` in
the model list, so the catalog marks them `kind: "systemone"` (a System One
model) with unknown thinking/tools; their vision support comes from the
top-level `has_vision_adapter` flag rather than `capabilities.vision`, and
surfaces in the decisions editor's model picker and on the settings Models
page. They never appear in the composer's model picker.

## System One

`POST /v1/systemone` — the native TypeSafe/llama.cpp System One API, served by
the same loaded decision models as `/v1/decisions`. Questions are keyed by name
rather than ordered, the evidence field is `state`, and the boolean question
type is `noul`.

```bash
curl http://localhost:1234/v1/systemone \
  -H "Authorization: Bearer $LM_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "your-decision-model",
    "state": "I was charged twice.",
    "questions": {
      "angry": {"type": "noul", "instructions": "Is the customer angry?"}
    }
  }'
```

Question types are `noul` (probability a condition is true; optional `criteria`
`{true, false}` descriptions), `choice` (a `criteria` map of value →
description), and `score` (an ordered `criteria` array of level descriptions).
The response is an `answers` object keyed by question id; a `noul` answer
carries its probability under `noul`, a choice carries `choice`/`probabilities`/
`confidence`, and a score carries `score`/`legend`/`probabilities`/`confidence`.
Images must be inline base64 data URLs and require a model with vision.

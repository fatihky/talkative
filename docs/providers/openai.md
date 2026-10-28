<!--
  OpenAI API reference

  Decisions guide (request/response shapes live here):
    https://developers.openai.com/api/docs/guides/decisions.md
  Connect voice to Decisions:
    https://developers.openai.com/api/docs/guides/decisions-voice.md
  Reasoning models (effort levels):
    https://developers.openai.com/api/docs/guides/reasoning.md
  Using GPT-6 (per-model effort support):
    https://developers.openai.com/api/docs/guides/latest-model.md

  Add more endpoint links here as we document the APIs this provider supports.

  OpenAI is the base dialect: chat completions here are the shape every other
  compatibility mirrors (see src/server/runs.ts and src/server/complete.ts), so
  this file documents the endpoints and parameters that are OpenAI-specific
  rather than the shared chat-completions parameters.
-->

# OpenAI

## Reasoning effort

`reasoning_effort` (top-level on chat completions, `reasoning.effort` on
responses) is model-dependent: values can include `none`, `minimal`, `low`,
`medium`, `high`, `xhigh` and `max`. `none` disables reasoning but is not
accepted everywhere — e.g. `gpt-6-astra` and `gpt-6.1-sol` return a 400 for it,
so the request is rejected outright rather than mapped to a neighbour.

## Decisions

`POST /v1/decisions` — evaluates one shared `input` against a list of
`questions` and returns one typed answer per question, in order. Public beta;
`gpt-6-luna` is the only model currently available.

```bash
curl https://api.openai.com/v1/decisions \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-6-luna",
    "input": "I was charged twice for my order.",
    "questions": [{
      "type": "choice",
      "name": "department",
      "instructions": "Which department should handle this complaint?",
      "choices": [
        {"value": "billing", "description": "Payments, invoices, and refunds."},
        {"value": "technical", "description": "Problems using the product."},
        {"value": "other", "description": "Requests outside these categories."}
      ]
    }]
  }'
```

### Request

| Field       | Type                               | Notes                                           |
| ----------- | ---------------------------------- | ----------------------------------------------- |
| `model`     | `string`                           | Required. The model that evaluates the request. |
| `input`     | `string \| DecisionInputMessage[]` | Required. Shared evidence for every question.   |
| `questions` | `DecisionQuestion[]`               | Required. Each carries a unique `name`.         |

`DecisionInputMessage` is `{ role: "user", content: string \| parts[] }`, where a
part is `{type: "input_text", text}` or `{type: "input_image", image_url}`.
Images must be inline base64 data URLs — hosted http(s) urls and `file_id`
inputs are not supported by this endpoint.

### Question

| Field          | Type                                 | Notes                                                       |
| -------------- | ------------------------------------ | ----------------------------------------------------------- |
| `type`         | `"predicate" \| "choice" \| "score"` | Required.                                                   |
| `name`         | `string`                             | Identifier echoed back on the answer.                       |
| `instructions` | `string`                             | The question, plus what to look for.                        |
| `choices`      | `{value, description?}[]`            | `choice` only: the selectable values.                       |
| `levels`       | `{label, description?}[]`            | `score` only: ordered lowest → highest; indices start at 0. |

`predicate` has no extra fields: it estimates the probability that the condition
in `instructions` holds. Put independent questions in one request; a question
that depends on an earlier answer needs a second request.

### Response

```json
{
  "answers": [
    { "type": "predicate", "name": "visible_damage", "probability": 0.92 },
    {
      "type": "choice",
      "name": "department",
      "choice": "billing",
      "probabilities": [
        { "value": "billing", "probability": 0.95 },
        { "value": "other", "probability": 0.05 }
      ],
      "confidence": 0.93
    },
    {
      "type": "score",
      "name": "severity",
      "score": 1.1,
      "probabilities": [
        { "value": 0, "label": "Cosmetic", "probability": 0.1 },
        { "value": 1, "label": "Workaround available", "probability": 0.7 },
        { "value": 2, "label": "Fully blocked", "probability": 0.2 }
      ],
      "confidence": 0.55
    }
  ]
}
```

| Field                     | Type     | Notes                                                                                      |
| ------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `answers[].type`          | `string` | The question's type, or `"refusal"` when the model declined.                               |
| `answers[].name`          | `string` | The question's name.                                                                       |
| `answers[].probability`   | `number` | `predicate`: estimate in [0,1] that the condition is true.                                 |
| `answers[].choice`        | `string` | `choice`: one of the supplied values.                                                      |
| `answers[].score`         | `number` | `score`: probability-weighted average of the level indices, so it can fall between levels. |
| `answers[].probabilities` | `array`  | `choice`/`score`: the distribution over values or levels.                                  |
| `answers[].confidence`    | `number` | `choice`/`score`: model confidence in the answer.                                          |

Pricing is input-only ($0.10 per 1M tokens for `gpt-6-luna`): no cache-read,
cache-write or output-token charges, though long-context input pricing
multipliers and regional processing premiums apply. Zero Data Retention and
HIPAA use are supported for eligible customers; data residency and regional
processing are supported in the United States and Europe (EEA + Switzerland).

<!--
  Ollama API reference

  Model list ("tags"):
    https://docs.ollama.com/api/tags.md
  Decision capability:
    https://docs.ollama.com/capabilities/decision.md
  System One:
    https://docs.ollama.com/api/systemone.md

  Add more endpoint links here as we document the APIs this provider supports.
-->

# Ollama

## Tags (model list)

`GET /api/tags` — fetch a list of models and their details.

```bash
curl http://localhost:11434/api/tags
```

### Response

```json
{ "models": [ /* ModelSummary, … */ ] }
```

### ModelSummary

| Field | Type | Notes |
| --- | --- | --- |
| `name` | `string` | Model name. |
| `model` | `string` | Model name. |
| `remote_model` | `string` | Upstream model name, if remote. |
| `remote_host` | `string` | Upstream Ollama host URL, if remote. |
| `modified_at` | `string` | Last modified, ISO 8601. |
| `size` | `integer` | Total size on disk in bytes. |
| `digest` | `string` | SHA256 digest of the model contents. |
| `details` | `object` | Format and family info. |
| `details.format` | `string` | Model file format, e.g. `gguf`. |
| `details.family` | `string` | Primary family, e.g. `llama`. |
| `details.families` | `string[]` | All families the model belongs to. |
| `details.parameter_size` | `string` | Approximate parameter count, e.g. `7B`, `13B`. |
| `details.quantization_level` | `string` | Quantization level, e.g. `Q4_0`. |
| `capabilities` | `string[]` | Recognized capabilities of the model, e.g. `completion`, `embedding`, `vision`, `tools`, `thinking`, `decision`. |

`capabilities` is how Ollama advertises what a model can do. The `decision`
capability marks a System One model (see below); a model without it answers
only `/v1/chat/completions`.

## Decisions

Ollama has no OpenAI-style `/v1/decisions` endpoint; its decisions are served by
the native `/v1/systemone` endpoint (see below). `server/catalog.ts` maps the
`decision` capability to `kind: "systemone"` so a decision-capable model routes
there, while a model whose tags report no `decision` capability stays `llm`.

## System One

`POST /v1/systemone` — answers choice, yes/no, and scoring questions with a
local System One model. Requires Ollama v0.35.0 or later.

```bash
curl http://localhost:11434/v1/systemone \
  -H "Content-Type: application/json" \
  -d '{
    "model": "nimble",
    "state": "Our checkout has returned 500 errors since 9am.",
    "questions": {
      "label": {
        "type": "choice",
        "instructions": "Which label fits this ticket?",
        "criteria": {
          "billing": "Payments and refunds",
          "bug": "Software errors",
          "account": "Login and account access"
        }
      }
    }
  }'
```

Request: `model`, `state` (the shared evidence for every question), and
`questions` keyed by name (≤64) with types `noul`, `choice` and `score`. Returns
one JSON response; streaming, video, tools and generation controls are not
supported. A `noul` answer carries its `noul` probability; `choice` and `score`
answers carry `probabilities` and `confidence` (`score` also a `legend` and
probability-weighted `score`), with `usage` `{input_tokens, output_tokens}`.

The catalog has no tag-level System One flag of its own, but a model's
`capabilities` array carries `"decision"` when it can answer `/v1/systemone`, so
`server/catalog.ts` marks those models `kind: "systemone"` from the capability
rather than from the model name.

/*
 * models — the shared model-kind predicates the pickers gate on.
 *
 * Business logic:
 * - Model.kind is optional and defaults to 'llm' for backends that don't
 *   distinguish, so every predicate here treats an unset kind as llm.
 * - only llm models can chat; embedding, decision and systemone models stay
 *   out of the composer picker but still show up (badged) in settings.
 * - a decisions run (OpenAI-style /v1/decisions) needs a `decision` model —
 *   lm studio reports type "decision" and openrouter reports
 *   `output_modalities: ["decisions"]` — while a systemone run (/v1/systemone)
 *   needs a `systemone` model (Jev, Nimble, Tev, …). openai and bifrost serve
 *   /v1/decisions from an ordinary chat model, so the decisions picker lists
 *   llm models too. embedding models answer neither.
 */
import type { Model, ModelKind } from '../types';

const kindOf = (m: Model): ModelKind => m.kind ?? 'llm';

export const isChattable = (m: Model): boolean => kindOf(m) === 'llm';

export const isDecisionModel = (m: Model): boolean => kindOf(m) === 'decision';

export const isSystemOneModel = (m: Model): boolean =>
  kindOf(m) === 'systemone';

/* a model a decision run can be evaluated with: a decision or systemone model */
export const isDecisionCapable = (m: Model): boolean =>
  isDecisionModel(m) || isSystemOneModel(m);

export const isEmbeddingModel = (m: Model): boolean =>
  kindOf(m) === 'embedding';

/* capability keywords a model matches, so the pickers' search can be queried
   by capability rather than name alone: "vi" → vision, "de" → decision models,
   "systemone" → the whole decision family (System One + decision models). */
export const capabilityTerms = (m: Model): string => {
  const terms: string[] = [];
  if (m.capabilities.thinking) terms.push('thinking', 'reasoning');
  if (m.capabilities.vision) terms.push('vision');
  if (m.capabilities.tools) terms.push('tools', 'tool');
  if (m.capabilities.audio) terms.push('audio');
  if (m.capabilities.json) terms.push('json');
  if (m.capabilities.fast) terms.push('fast');
  /* decision and systemone are one family: both answer a decision run, so both
     keywords surface every decision-capable model */
  if (isDecisionCapable(m))
    terms.push('decision', 'decisions', 'systemone', 'system one', 'system1');
  return terms.join(' ');
};

/* the pickers' search haystack: name, id, provider, plus capability keywords */
export const modelSearchText = (m: Model): string =>
  `${m.shortName} ${m.id} ${m.provider} ${capabilityTerms(m)}`;

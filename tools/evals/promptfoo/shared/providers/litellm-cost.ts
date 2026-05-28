// Cumulative USD cost of a (multi-step) streamText run, priced from token
// usage rather than LiteLLM's per-request cost header. Two reasons:
//   1. The header on `result.response` is the LAST step's cost only — useless
//      for the multi-step tool loops these suites run (a runaway loop's final
//      step can be cheap). `result.totalUsage` sums usage across ALL steps.
//   2. The header name churns across LiteLLM versions
//      (`x-litellm-response-cost` → `…-original` at >=1.86). Pricing from tokens
//      via the same snapshot the app uses sidesteps that fragility.

import { tokensToCost } from "@atlas/llm";

// LiteLLM alias (the model half of `registryId`, e.g. "friday-md") → the bare
// model id the pricing snapshot keys on. Mirrors litellm/litellm_config.yaml.
// The workspace-chat suites only ever run friday-md / friday-lg (they omit
// tier:small — Groq's context is too small for the ~9k-token system prompt).
// An unmapped alias THROWS rather than returning 0, so a `cost:` assert can't
// pass vacuously on an unpriced model.
const ALIAS_TO_PRICING_MODEL: Record<string, string> = {
  "friday-md": "claude-haiku-4-5",
  "friday-lg": "claude-sonnet-4-6",
};

interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
}

/** Price `result.totalUsage` for the given registry alias. Throws if the alias
 *  or model has no pricing row (cost must be a real number for the assert). */
export function cumulativeRunCostUsd(usage: RunUsage, alias: string): number {
  const modelId = ALIAS_TO_PRICING_MODEL[alias];
  if (!modelId) {
    throw new Error(
      `litellm-cost: no pricing model mapped for alias "${alias}" — ` +
        "add it to ALIAS_TO_PRICING_MODEL (mirror litellm/litellm_config.yaml)",
    );
  }
  const { total, pricingResolved } = tokensToCost(
    {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cachedInputTokens,
    },
    modelId,
  );
  if (!pricingResolved) {
    throw new Error(`litellm-cost: pricing snapshot has no row for model "${modelId}"`);
  }
  return total;
}

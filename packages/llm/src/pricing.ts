/**
 * Token → USD cost helper for usage roll-ups.
 *
 * Reads from a vendored pricing snapshot whose shape matches LiteLLM's
 * `model_prices_and_context_window.json` (per-model input/output/cache
 * cost in USD-per-token). The snapshot is hand-curated to the models
 * the registry actively serves; refresh by replacing the JSON with the
 * upstream file.
 *
 * The helper is provider-neutral. It looks up by model id (the same id
 * the chat handler stamps onto `MessageMetadata.modelId`) and returns
 * a breakdown that the UI can render directly. Unknown models — or
 * known models on which the provider didn't surface cache fields —
 * still return a sensible total; missing pieces contribute 0.
 */

import pricingSnapshot from "./pricing.json" with { type: "json" };

interface ModelPricing {
  litellm_provider?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
}

interface PricingSnapshot {
  _metadata?: unknown;
  [modelId: string]: ModelPricing | unknown;
}

const PRICES = pricingSnapshot as PricingSnapshot;

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface CostBreakdown {
  /** Cost of fresh (non-cached) input tokens. */
  input: number;
  /** Cost of output tokens. */
  output: number;
  /** Cost of input tokens served from cache (read at the discounted rate). */
  cacheRead: number;
  /** Cost of populating the cache (write rate; charged once per prefix). */
  cacheWrite: number;
  /** Sum of all four. */
  total: number;
  /** True iff the model id matched a row in the pricing snapshot. */
  pricingResolved: boolean;
}

/**
 * Strip the gateway prefix (e.g. `anthropic/`) off a registry-qualified
 * model id when looking up pricing. The pricing snapshot keys are bare
 * model ids (`claude-sonnet-4-6`); registry ids include the provider
 * prefix that the chat handler stamps for traceability.
 */
function normalizeModelId(modelId: string): string {
  const slash = modelId.indexOf("/");
  if (slash >= 0) return modelId.slice(slash + 1);
  const colon = modelId.indexOf(":");
  if (colon >= 0) return modelId.slice(colon + 1);
  return modelId;
}

function lookup(modelId: string): ModelPricing | null {
  const direct = PRICES[modelId];
  if (direct && typeof direct === "object" && "input_cost_per_token" in direct) {
    return direct as ModelPricing;
  }
  const normalized = normalizeModelId(modelId);
  if (normalized !== modelId) {
    const fallback = PRICES[normalized];
    if (fallback && typeof fallback === "object" && "input_cost_per_token" in fallback) {
      return fallback as ModelPricing;
    }
  }
  return null;
}

/**
 * Compute the USD cost of a turn's token usage at the given model's
 * rates. The "fresh" input is `inputTokens - cacheReadTokens`: the
 * provider reports `inputTokens` as the total prompt size but bills the
 * cached portion at the read rate, not the fresh rate. Cache write is
 * billed separately on the populating turn.
 *
 * Returns zeros when the model id is unknown — in that case
 * `pricingResolved` is `false` and the caller should surface "pricing
 * unavailable" rather than display a zeroed total.
 */
export function tokensToCost(usage: TokenUsage, modelId: string): CostBreakdown {
  const prices = lookup(modelId);
  if (!prices) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, pricingResolved: false };
  }

  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;

  // The provider reports `inputTokens` as the FULL prompt size. The
  // cached portion is billed at `cache_read_input_token_cost`, not
  // `input_cost_per_token`. Subtract so we don't double-count.
  const freshInputTokens = Math.max(0, inputTokens - cacheReadTokens);

  const input = freshInputTokens * (prices.input_cost_per_token ?? 0);
  const output = outputTokens * (prices.output_cost_per_token ?? 0);
  const cacheRead = cacheReadTokens * (prices.cache_read_input_token_cost ?? 0);
  const cacheWrite = cacheWriteTokens * (prices.cache_creation_input_token_cost ?? 0);

  const total = input + output + cacheRead + cacheWrite;

  return { input, output, cacheRead, cacheWrite, total, pricingResolved: true };
}

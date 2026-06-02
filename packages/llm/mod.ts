import type { ImageModelV3, LanguageModelV3, SharedV2ProviderOptions } from "@ai-sdk/provider";

export type { ImageModelV3, LanguageModelV3 };

import { deepMerge } from "@std/collections/deep-merge";
import { anthropicProviderOptions } from "./src/anthropic.ts";
import type { ValidProvider } from "./src/util.ts";

export { createAnthropicWithOptions } from "./src/anthropic.ts";
export { createGoogleWithOptions } from "./src/google.ts";
export { createGroqWithOptions } from "./src/groq.ts";
export {
  type ImageCapabilities,
  type ImageDefaults,
  IMAGE_OVERLAY,
  type ImageOverlayEntry,
  listImageEntries,
  lookupImageEntry,
} from "./src/image-capabilities.ts";
export {
  buildTemporalFacts,
  type DatetimeContext,
  temporalGroundingMessage,
} from "./src/grounding.ts";
export {
  type Catalog,
  type CatalogEntry,
  type CatalogProvider,
  getCatalog,
  invalidateCatalog,
  type ModelInfo,
  PROVIDER_META,
  type ProviderMeta,
  prewarmCatalog,
} from "./src/model-catalog.ts";
export { createOpenAIWithOptions } from "./src/openai.ts";
export {
  createPlatformModels,
  DEFAULT_PLATFORM_MODELS,
  type PlatformModelConfig,
  type PlatformModels,
  PlatformModelsConfigError,
  type PlatformModelsInput,
  type PlatformRole,
  resolveModelFromString,
} from "./src/platform-models.ts";
export {
  type CostBreakdown,
  type TokenUsage,
  tokensToCost,
} from "./src/pricing.ts";
export { pruneMessages } from "./src/prune-messages.ts";
export { registry, resetRegistry } from "./src/registry.ts";
export {
  buildRegistryModelId,
  isRegistryProvider,
  REGISTRY_PROVIDERS,
  type RegistryModelId,
  type RegistryProvider,
} from "./src/registry-id.ts";
export {
  type ProvenanceSource,
  provenanceForSignalProvider,
  wrapRetrieved,
} from "./src/retrieved-content.ts";
export {
  type GenerateSessionTitleInput,
  generateSessionTitle,
} from "./src/session-title.ts";
export { smallLLM } from "./src/small.ts";
export { createStubPlatformModels } from "./src/test-utils.ts";
export {
  enterTraceScope,
  enterUsageScope,
  getActiveUsageCounter,
  type TraceEntry,
  traceModel,
  type UsageCounter,
} from "./src/tracing.ts";
export { validateProvider } from "./src/util.ts";

/**
 * Per-message provider options for caching. Attach to the system message
 * (or any content block) you want to act as the cache breakpoint.
 *
 * Anthropic: 1h ephemeral cache_control on the attached content block —
 *   matches every block from the start of the prompt up to and including
 *   the marked block, so place it on the static prefix (system prompt).
 *   OpenAI ignores per-message providerOptions for caching.
 *
 * @param provider inference provider
 * @param overrides call-site specific options merged on top of the defaults
 */
export function getDefaultProviderOpts(
  provider: ValidProvider,
  overrides?: SharedV2ProviderOptions,
): SharedV2ProviderOptions {
  let defaults: SharedV2ProviderOptions = {};
  switch (provider) {
    case "anthropic":
      defaults = anthropicProviderOptions;
    // Add more providers here
  }

  if (!overrides) {
    return defaults;
  }
  return deepMerge(defaults, overrides);
}

/**
 * Top-level (request-scope) provider options for caching. Merge into the
 * `providerOptions` field of generateText / streamText / generateObject.
 *
 * OpenAI: prompt_cache_key routing hint. OpenAI caches prefixes ≥1024
 *   tokens automatically; the key improves cache-routing reliability so
 *   requests from the same logical call site land on the same warm
 *   cache. Use a stable per-call-site string (e.g. `"agent-summary"`,
 *   `"slack-plan"`) — colliding keys across unrelated call sites
 *   degrade routing.
 * Anthropic: no top-level caching knob — cache_control sits per-message
 *   (see `getDefaultProviderOpts`).
 */
export function getCachingRequestOpts(opts: { cacheKey: string }): SharedV2ProviderOptions {
  return { openai: { promptCacheKey: opts.cacheKey } };
}

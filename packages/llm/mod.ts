import type { LanguageModelV3, SharedV2ProviderOptions } from "@ai-sdk/provider";

export type { LanguageModelV3 };

import { deepMerge } from "@std/collections/deep-merge";
import { anthropicProviderOptions } from "./src/anthropic.ts";
import type { ValidProvider } from "./src/util.ts";

export { createAnthropicWithOptions } from "./src/anthropic.ts";
export { createGoogleWithOptions } from "./src/google.ts";
export { createGroqWithOptions } from "./src/groq.ts";
export {
  buildTemporalFacts,
  type DatetimeContext,
  temporalGroundingMessage,
} from "./src/grounding.ts";
export { createOpenAIWithOptions } from "./src/openai.ts";
export {
  createPlatformModels,
  DEFAULT_PLATFORM_MODELS,
  type PlatformModels,
  PlatformModelsConfigError,
  type PlatformModelsInput,
  type PlatformRole,
} from "./src/platform-models.ts";
export { pruneMessages } from "./src/prune-messages.ts";
export { registry } from "./src/registry.ts";
export {
  buildRegistryModelId,
  isRegistryProvider,
  REGISTRY_PROVIDERS,
  type RegistryModelId,
  type RegistryProvider,
} from "./src/registry-id.ts";
export {
  type GenerateSessionTitleInput,
  generateSessionTitle,
} from "./src/session-title.ts";
export { smallLLM } from "./src/small.ts";
export { createStubPlatformModels } from "./src/test-utils.ts";
export { enterTraceScope, type TraceEntry, traceModel } from "./src/tracing.ts";
export { validateProvider } from "./src/util.ts";

/**
 * Retrieves our default set of provider-specific metadata to apply
 * to generate/stream LLM calls.
 * @see https://ai-sdk.dev/docs/foundations/prompts#provider-options
 *
 * @param provider inference provider
 * @param overrides call-site specific options
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

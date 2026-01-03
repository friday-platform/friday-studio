import type { SharedV2ProviderOptions } from "@ai-sdk/provider";
import { deepMerge } from "@std/collections/deep-merge";
import { anthropicProviderOptions } from "./src/anthropic.ts";
import type { ValidProvider } from "./src/util.ts";

export { createAnthropicWithOptions } from "./src/anthropic.ts";
export { createGoogleWithOptions } from "./src/google.ts";
export { createGroqWithOptions } from "./src/groq.ts";
export { createOpenAIWithOptions } from "./src/openai.ts";
export { pruneMessages } from "./src/prune-messages.ts";
export { registry } from "./src/registry.ts";
export { smallLLM } from "./src/small.ts";
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

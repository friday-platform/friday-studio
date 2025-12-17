import process from "node:process";
import { createOpenAI } from "@ai-sdk/openai";
import type { SharedV2ProviderOptions } from "@ai-sdk/provider";
import { deepMerge } from "@std/collections/deep-merge";
import { createProviderRegistry } from "ai";
import { anthropicProviderOptions, createAnthropicWithOptions } from "./src/anthropic.ts";
import { createGoogleWithOptions } from "./src/google.ts";
import { createGroqWithOptions } from "./src/groq.ts";
import { createOpenAIWithOptions } from "./src/openai.ts";
import type { ValidProvider } from "./src/util.ts";

export { createAnthropicWithOptions } from "./src/anthropic.ts";
export { createGoogleWithOptions } from "./src/google.ts";
export { createGroqWithOptions } from "./src/groq.ts";
export { createOpenAIWithOptions } from "./src/openai.ts";
export { pruneMessages } from "./src/prune-messages.ts";
export { smallLLM } from "./src/small.ts";
export { validateProvider } from "./src/util.ts";

/**
 * Creates provider registry based on environment.
 * If LITELLM_API_KEY is set, routes requests through LiteLLM proxy.
 * - Anthropic: Uses native /v1/messages endpoint (avoids tool message translation bugs)
 * - Others: Uses OpenAI-compatible /chat/completions endpoint
 * Otherwise, uses direct provider connections.
 */
function createRegistry() {
  const litellmKey = process.env.LITELLM_API_KEY;
  const litellmBaseURL = process.env.LITELLM_BASE_URL || "http://localhost:4000";

  if (litellmKey) {
    // Anthropic: Use native format via /v1/messages to avoid tool message translation bugs
    // See: https://github.com/BerriAI/litellm/issues/5747
    // The Anthropic SDK appends /messages to the baseURL, so we need /v1 in the path
    const anthropicViaLitellm = createAnthropicWithOptions({
      apiKey: litellmKey,
      baseURL: `${litellmBaseURL}/v1`,
    });

    // Other providers: Use OpenAI-compatible /chat/completions
    const litellmOpenAI = createOpenAI({ apiKey: litellmKey, baseURL: litellmBaseURL });

    return createProviderRegistry({
      anthropic: anthropicViaLitellm,
      google: litellmOpenAI,
      groq: litellmOpenAI,
      openai: litellmOpenAI,
    });
  }

  // Direct provider connections
  return createProviderRegistry({
    anthropic: createAnthropicWithOptions(),
    google: createGoogleWithOptions(),
    groq: createGroqWithOptions(),
    openai: createOpenAIWithOptions(),
  });
}

/**
 * Unified provider registry with all supported LLM providers
 * Access models via: registry.languageModel('provider:model')
 * Examples:
 *   - registry.languageModel('anthropic:claude-3-5-sonnet-20241022')
 *   - registry.languageModel('openai:gpt-4')
 *   - registry.languageModel('google:gemini-pro')
 *   - registry.languageModel('groq:llama-3.3-70b-versatile')
 *
 * When LITELLM_API_KEY is set, all requests route through LiteLLM proxy.
 */
export const registry = createRegistry();

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

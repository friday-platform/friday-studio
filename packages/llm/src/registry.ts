import process from "node:process";
import type { OpenAIProvider } from "@ai-sdk/openai";
import { createOpenAI } from "@ai-sdk/openai";
import type { ProviderV2 } from "@ai-sdk/provider";
import { createProviderRegistry } from "ai";
import { createAnthropicWithOptions } from "./anthropic.ts";
import { createGoogleWithOptions } from "./google.ts";
import { createGroqWithOptions } from "./groq.ts";
import { createOpenAIWithOptions } from "./openai.ts";

/**
 * Creates a wrapper provider that forces the Chat Completions API.
 *
 * The @ai-sdk/openai package defaults to the Responses API when you call provider(modelId).
 * LiteLLM does not properly support the Responses API format for non-OpenAI models
 * (e.g., returns null for text fields in tool calls).
 *
 * This wrapper ensures we use provider.chat(modelId) which uses the Chat Completions API.
 */
function createChatCompletionsProvider(baseProvider: OpenAIProvider): ProviderV2 {
  return {
    languageModel: (modelId: string) => baseProvider.chat(modelId),
    textEmbeddingModel: (modelId: string) => baseProvider.textEmbeddingModel(modelId),
    imageModel: (modelId: string) => baseProvider.imageModel(modelId),
  };
}

/**
 * Creates provider registry based on environment.
 * If LITELLM_API_KEY is set, routes requests through LiteLLM proxy.
 * - Anthropic: Uses native /v1/messages passthrough
 * - Google & OpenAI: Uses OpenAI-compatible /chat/completions endpoint
 * - Groq: Uses native SDK to preserve provider-specific options
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

    // Groq: Use native SDK to preserve provider-specific options (e.g., reasoningFormat)
    const groqViaLitellm = createGroqWithOptions({ apiKey: litellmKey, baseURL: litellmBaseURL });

    // Google & OpenAI: Force Chat Completions API via createChatCompletionsProvider.
    // The default @ai-sdk/openai uses Responses API, which LiteLLM doesn't properly
    // support for non-OpenAI models (returns null for text fields in tool calls).
    const litellmOpenAI = createOpenAI({ apiKey: litellmKey, baseURL: litellmBaseURL });
    const litellmChatProvider = createChatCompletionsProvider(litellmOpenAI);

    return createProviderRegistry({
      anthropic: anthropicViaLitellm,
      google: litellmChatProvider,
      groq: groqViaLitellm,
      openai: litellmChatProvider,
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
 *   - registry.languageModel('anthropic:claude-sonnet-4-5')
 *   - registry.languageModel('openai:gpt-4')
 *   - registry.languageModel('google:gemini-pro')
 *   - registry.languageModel('groq:llama-3.3-70b-versatile')
 *
 * When LITELLM_API_KEY is set, all requests route through LiteLLM proxy.
 *
 * Note: Lazily initialized to allow credentials to be loaded before first use.
 */
let _registry: ReturnType<typeof createRegistry> | null = null;

export const registry = {
  languageModel: (...args: Parameters<ReturnType<typeof createRegistry>["languageModel"]>) => {
    if (!_registry) _registry = createRegistry();
    return _registry.languageModel(...args);
  },
  textEmbeddingModel: (
    ...args: Parameters<ReturnType<typeof createRegistry>["textEmbeddingModel"]>
  ) => {
    if (!_registry) _registry = createRegistry();
    return _registry.textEmbeddingModel(...args);
  },
};

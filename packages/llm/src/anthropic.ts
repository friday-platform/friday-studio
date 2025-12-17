import process from "node:process";
import {
  type AnthropicProvider,
  type AnthropicProviderSettings,
  createAnthropic,
} from "@ai-sdk/anthropic";
import type { SharedV2ProviderOptions } from "@ai-sdk/provider";
import { createProxyFetch, PROVIDER_ENV_VARS } from "./util.ts";

/**
 * Anthropic prompt caching configuration
 * System prompts marked with this will be cached by Anthropic (if >1024 tokens)
 * Cache hits significantly reduce latency by skipping prompt processing
 */
export const anthropicProviderOptions: SharedV2ProviderOptions = {
  anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
};

/**
 * Configuration options for creating an Anthropic client
 */
interface AnthropicOptions {
  /** API key for Anthropic. Defaults to ANTHROPIC_API_KEY env var */
  apiKey?: string;
  /** HTTP proxy URL. Defaults to ANTHROPIC_PROXY_URL env var */
  httpProxy?: string;
  /** Base URL for API requests. Use for LiteLLM proxy routing. */
  baseURL?: string;
}

/**
 * Creates an Anthropic client with configurable options
 * This is exported for use in other parts of the codebase that need direct Anthropic access
 *
 * @param opts Configuration options for the Anthropic client
 * @returns Configured Anthropic provider instance
 */
export function createAnthropicWithOptions(opts: AnthropicOptions = {}): AnthropicProvider {
  const httpProxy = opts.httpProxy || process.env.ANTHROPIC_PROXY_URL;

  const anthropicOptions: AnthropicProviderSettings = {
    apiKey: opts.apiKey || process.env[PROVIDER_ENV_VARS.anthropic],
  };
  if (httpProxy) {
    anthropicOptions.fetch = createProxyFetch(httpProxy);
  }
  if (opts.baseURL) {
    anthropicOptions.baseURL = opts.baseURL;
  }
  return createAnthropic(anthropicOptions);
}

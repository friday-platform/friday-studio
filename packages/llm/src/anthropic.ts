import process from "node:process";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createProxyFetch, PROVIDER_ENV_VARS } from "./util.ts";

/**
 * Anthropic prompt caching configuration
 * System prompts marked with this will be cached by Anthropic (if >1024 tokens)
 * Cache hits significantly reduce latency by skipping prompt processing
 */
export const ANTHROPIC_CACHE_BREAKPOINT = {
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
}

/**
 * Creates an Anthropic client with configurable options
 * This is exported for use in other parts of the codebase that need direct Anthropic access
 *
 * @param options Configuration options for the Anthropic client
 * @returns Configured Anthropic provider instance
 */
export function createAnthropicWithOptions(
  options: AnthropicOptions = {},
): ReturnType<typeof createAnthropic> {
  const apiKey = options.apiKey || process.env[PROVIDER_ENV_VARS.anthropic];
  const httpProxy = options.httpProxy || process.env.ANTHROPIC_PROXY_URL;

  const anthropicOptions: Parameters<typeof createAnthropic>[0] = { apiKey };

  if (httpProxy) {
    anthropicOptions.fetch = createProxyFetch(httpProxy);
  }

  return createAnthropic(anthropicOptions);
}

/** Pre-configured Anthropic instance with proxy support from environment */
export const anthropic = createAnthropicWithOptions();

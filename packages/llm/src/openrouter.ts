import process from "node:process";
import { createOpenAI, type OpenAIProvider, type OpenAIProviderSettings } from "@ai-sdk/openai";
import { createProxyFetch, PROVIDER_ENV_VARS } from "./util.ts";

/**
 * Configuration options for creating an OpenRouter client
 */
interface OpenRouterOptions {
  /** API key for OpenRouter. Defaults to OPENROUTER_API_KEY env var */
  apiKey?: string;
  /** HTTP proxy URL. Defaults to OPENROUTER_PROXY_URL env var */
  httpProxy?: string;
}

/**
 * Creates an OpenRouter client.
 *
 * OpenRouter exposes an OpenAI-compatible Chat Completions API, so we point
 * @ai-sdk/openai at openrouter.ai/api/v1. The `HTTP-Referer` and
 * `X-OpenRouter-Title` headers identify Friday on openrouter.ai/rankings —
 * without them usage is anonymous and won't surface on the app's leaderboard.
 *
 * @param opts Configuration options for the OpenRouter client
 * @returns Configured OpenAI provider instance pointed at OpenRouter
 */
export function createOpenRouterWithOptions(opts: OpenRouterOptions = {}): OpenAIProvider {
  const httpProxy = opts.httpProxy || process.env.OPENROUTER_PROXY_URL;

  const openrouterOptions: OpenAIProviderSettings = {
    apiKey: opts.apiKey || process.env[PROVIDER_ENV_VARS.openrouter],
    baseURL: "https://openrouter.ai/api/v1",
    headers: {
      "HTTP-Referer": "https://hellofriday.ai/",
      "X-OpenRouter-Title": "Friday",
    },
  };
  if (httpProxy) {
    openrouterOptions.fetch = createProxyFetch(httpProxy);
  }
  return createOpenAI(openrouterOptions);
}

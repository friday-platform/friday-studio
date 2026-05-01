import process from "node:process";
import { createOpenAI, type OpenAIProvider, type OpenAIProviderSettings } from "@ai-sdk/openai";
import { createProxyFetch, PROVIDER_ENV_VARS } from "./util.ts";

/**
 * Configuration options for creating an OpenAI client
 */
interface OpenAIOptions {
  /** API key for OpenAI. Defaults to OPENAI_API_KEY env var */
  apiKey?: string;
  /** HTTP proxy URL. Defaults to OPENAI_PROXY_URL env var */
  httpProxy?: string;
}

/**
 * Creates an OpenAI client with configurable options
 * This is exported for use in other parts of the codebase that need direct OpenAI access
 *
 * @param opts Configuration options for the OpenAI client
 * @returns Configured OpenAI provider instance
 */
export function createOpenAIWithOptions(opts: OpenAIOptions = {}): OpenAIProvider {
  const httpProxy = opts.httpProxy || process.env.OPENAI_PROXY_URL;

  const openaiOptions: OpenAIProviderSettings = {
    apiKey: opts.apiKey || process.env[PROVIDER_ENV_VARS.openai],
  };
  if (httpProxy) {
    openaiOptions.fetch = createProxyFetch(httpProxy);
  }
  return createOpenAI(openaiOptions);
}

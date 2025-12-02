import process from "node:process";
import { createGroq, type GroqProvider, type GroqProviderSettings } from "@ai-sdk/groq";
import { createProxyFetch, PROVIDER_ENV_VARS } from "./util.ts";

/**
 * Configuration options for creating a Groq client
 */
interface GroqOptions {
  /** API key for Groq. Defaults to GROQ_API_KEY env var */
  apiKey?: string;
  /** HTTP proxy URL. Defaults to GROQ_PROXY_URL env var */
  httpProxy?: string;
}

/**
 * Creates a Groq client with configurable options
 * This is exported for use in other parts of the codebase that need direct Groq access
 *
 * @param opts Configuration options for the Groq client
 * @returns Configured Groq provider instance
 */
export function createGroqWithOptions(opts: GroqOptions = {}): GroqProvider {
  const httpProxy = opts.httpProxy || process.env.GROQ_PROXY_URL;

  const groqOptions: GroqProviderSettings = {
    apiKey: opts.apiKey || process.env[PROVIDER_ENV_VARS.groq],
  };
  if (httpProxy) {
    groqOptions.fetch = createProxyFetch(httpProxy);
  }
  return createGroq(groqOptions);
}

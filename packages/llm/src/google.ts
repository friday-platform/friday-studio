import process from "node:process";
import {
  createGoogleGenerativeAI,
  type GoogleGenerativeAIProvider,
  type GoogleGenerativeAIProviderSettings,
} from "@ai-sdk/google";
import { createProxyFetch, PROVIDER_ENV_VARS } from "./util.ts";

/**
 * Configuration options for creating a Google AI client
 */
interface GoogleOptions {
  /** API key for Google AI. Defaults to GEMINI_API_KEY env var */
  apiKey?: string;
  /** HTTP proxy URL. Defaults to GOOGLE_PROXY_URL env var */
  httpProxy?: string;
}

/**
 * Creates a Google AI client with configurable options
 * This is exported for use in other parts of the codebase that need direct Google AI access
 *
 * @param opts Configuration options for the Google AI client
 * @returns Configured Google AI provider instance
 */
export function createGoogleWithOptions(opts: GoogleOptions = {}): GoogleGenerativeAIProvider {
  const httpProxy = opts.httpProxy || process.env.GOOGLE_PROXY_URL;

  const googleOptions: GoogleGenerativeAIProviderSettings = {
    apiKey: opts.apiKey || process.env[PROVIDER_ENV_VARS.google],
  };
  if (httpProxy) {
    googleOptions.fetch = createProxyFetch(httpProxy);
  }
  return createGoogleGenerativeAI(googleOptions);
}

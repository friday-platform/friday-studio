import { logger } from "@atlas/logger";

/**
 * Creates a fetch function that uses an HTTP proxy
 * @param proxyUrl The proxy URL to use
 * @returns A fetch function configured to use the proxy
 */
export function createProxyFetch(proxyUrl: string): typeof fetch {
  const httpClient = Deno.createHttpClient({ proxy: { url: proxyUrl } });
  logger.info("Proxy configured", { proxyUrl });

  return async (url: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
    return await fetch(url, { ...options, client: httpClient });
  };
}

/**
 * Environment variable names for different LLM providers
 */
export const PROVIDER_ENV_VARS = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
} as const;

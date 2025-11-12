import { logger } from "@atlas/logger";
import { z } from "zod";

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
export const PROVIDER_ENV_VARS: Record<ValidProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
} as const;

const ValidProviderSchema = z.enum(["anthropic", "google", "openai"]);
export type ValidProvider = z.infer<typeof ValidProviderSchema>;

/**
 * Validate that the provider is supported
 * @param provider Provider name
 */
export function validateProvider(provider: string): ValidProvider {
  return ValidProviderSchema.parse(provider);
}

import { logger } from "@atlas/logger";
import type { RequestInit as UndiciRequestInit } from "undici";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { z } from "zod";

/**
 * Creates a fetch function that uses an HTTP proxy.
 *
 * undici and globalThis define structurally identical but nominally distinct
 * Request/Response types. We bridge the gap by casting through `unknown` at
 * both the input (RequestInit) and output (Response) boundaries.
 *
 * @param proxyUrl The proxy URL to use
 * @returns A fetch function configured to use the proxy
 */
export function createProxyFetch(proxyUrl: string): typeof fetch {
  const dispatcher = new ProxyAgent(proxyUrl);
  logger.info("Proxy configured", { proxyUrl });

  const proxyFetch: typeof fetch = async (url, options) => {
    const urlString = String(url instanceof Request ? url.url : url);
    const undiciOptions = { ...options, dispatcher } as unknown as UndiciRequestInit;
    const response = await undiciFetch(urlString, undiciOptions);
    return response as unknown as Response;
  };
  return proxyFetch;
}

/**
 * Environment variable names for different LLM providers
 */
export const PROVIDER_ENV_VARS: Record<ValidProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  google: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  openai: "OPENAI_API_KEY",
} as const;

const ValidProviderSchema = z.enum(["anthropic", "google", "groq", "openai"]);
export type ValidProvider = z.infer<typeof ValidProviderSchema>;

/**
 * Validate that the provider is supported
 * @param provider Provider name
 */
export function validateProvider(provider: string): ValidProvider {
  return ValidProviderSchema.parse(provider);
}

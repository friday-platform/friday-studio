/**
 * LLM Provider Registry
 *
 * Creates and manages the Vercel AI SDK provider registry with support for
 * Anthropic, OpenAI, and Google AI providers. Loads API keys from environment.
 */

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createProviderRegistry, type ProviderRegistryProvider } from "ai";
import { createAnthropicWithOptions } from "../llm-provider.ts";

/**
 * Create the AI SDK provider registry with all supported providers
 *
 * @param env Environment variables containing API keys
 * @returns Configured provider registry
 */
function createProviders(env: Record<string, string> = {}): ProviderRegistryProvider {
  // Use provided env or fall back to Deno.env
  const getEnvVar = (key: string) => env[key] || Deno.env.get(key);

  return createProviderRegistry({
    anthropic: createAnthropicWithOptions({ apiKey: getEnvVar("ANTHROPIC_API_KEY") }),
    openai: createOpenAI({ apiKey: getEnvVar("OPENAI_API_KEY") }),
    google: createGoogleGenerativeAI({ apiKey: getEnvVar("GOOGLE_GENERATIVE_AI_API_KEY") }),
  });
}

/**
 * Eagerly initialized provider registry instance
 */
export const registry = createProviders();

/**
 * Validate that required environment variables are present
 *
 * @param provider Provider name
 * @param env Environment variables
 * @throws Error if required API key is missing
 */
export function validateProviderConfig(provider: string, env: Record<string, string> = {}): void {
  const envVarMap: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GOOGLE_GENERATIVE_AI_API_KEY",
  };

  const requiredVar = envVarMap[provider];
  if (!requiredVar) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const value = env[requiredVar] || Deno.env.get(requiredVar);
  if (!value) {
    throw new Error(
      `Missing required environment variable ${requiredVar} for provider ${provider}`,
    );
  }
}

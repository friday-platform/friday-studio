/**
 * Shared typing helpers for `registry.languageModel` inputs. Consolidates the
 * provider whitelist, the template-literal id union, and the narrowing helpers
 * used by both `platform-models.ts` and `fsm-engine`'s adapter.
 */

export const REGISTRY_PROVIDERS = ["anthropic", "claude-code", "google", "groq", "openai"] as const;

export type RegistryProvider = (typeof REGISTRY_PROVIDERS)[number];

/**
 * Registry-accepted model id template — mirrors the literal union produced by
 * `createProviderRegistry` so `registry.languageModel` accepts our strings
 * without casts.
 */
export type RegistryModelId =
  | `anthropic:${string}`
  | `claude-code:${string}`
  | `google:${string}`
  | `groq:${string}`
  | `openai:${string}`;

export function isRegistryProvider(p: string): p is RegistryProvider {
  return (REGISTRY_PROVIDERS as readonly string[]).includes(p);
}

/**
 * Build a typed registry model id from a validated provider + model. Callers
 * must have already verified the provider via `isRegistryProvider`.
 */
export function buildRegistryModelId(provider: RegistryProvider, model: string): RegistryModelId {
  switch (provider) {
    case "anthropic":
      return `anthropic:${model}`;
    case "claude-code":
      return `claude-code:${model}`;
    case "google":
      return `google:${model}`;
    case "groq":
      return `groq:${model}`;
    case "openai":
      return `openai:${model}`;
  }
}

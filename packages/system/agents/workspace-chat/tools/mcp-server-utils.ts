import type { LinkCredentialRef } from "@atlas/agent-sdk";

/**
 * Derive credential-setup hints from a server's env configuration.
 *
 * Used by install/create tools to tell the LLM whether the user needs to
 * connect credentials, and if so, how (Link provider ID or raw env var names).
 *
 * @param env - The server's configTemplate.env map
 * @returns Object with needsCredentials flag and optional provider/requiredConfig
 */
export function deriveCredentialHints(
  env: Record<string, string | LinkCredentialRef> | undefined,
): { needsCredentials: boolean; provider?: string; requiredConfig?: string[] } {
  if (!env || Object.keys(env).length === 0) {
    return { needsCredentials: false };
  }

  let provider: string | undefined;
  const requiredConfig: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "object" && value !== null) {
      if (value.provider) {
        provider = value.provider;
      }
    } else {
      requiredConfig.push(key);
    }
  }

  return {
    needsCredentials: true,
    ...(provider !== undefined && { provider }),
    ...(requiredConfig.length > 0 && { requiredConfig }),
  };
}

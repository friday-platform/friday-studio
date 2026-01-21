/**
 * Pre-flight credential validation for FSM workspace creation.
 * Validates that all required Link credentials are bound before expensive FSM generation.
 */

import type { CredentialBinding } from "@atlas/core/artifacts";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import type { MissingCredential } from "../../agent-types/mod.ts";
import type { MCPServerResult } from "./enrichers/mcp-servers.ts";

/**
 * Pre-flight validation result
 */
export interface PreflightResult {
  valid: boolean;
  missingCredentials: MissingCredential[];
}

/**
 * Validates that all required Link credentials are bound for the given MCP servers.
 *
 * @param mcpServers - MCP servers that will be used by the workspace
 * @param credentials - Credential bindings from the workspace plan
 * @returns Validation result with missing credentials if any
 */
export function validateCredentials(
  mcpServers: MCPServerResult[],
  credentials?: CredentialBinding[],
): PreflightResult {
  const missingCredentials: MissingCredential[] = [];

  for (const server of mcpServers) {
    const serverMeta = mcpServersRegistry.servers[server.id];
    if (!serverMeta?.configTemplate?.env) continue;

    for (const [_envKey, envConfig] of Object.entries(serverMeta.configTemplate.env)) {
      if (typeof envConfig === "object" && envConfig.from === "link" && envConfig.provider) {
        // Check if plan has a credential binding for this provider
        const hasBinding = credentials?.some((c) => c.provider === envConfig.provider);
        if (!hasBinding) {
          // Avoid duplicates (same provider may be needed by multiple env vars)
          const alreadyAdded = missingCredentials.some((c) => c.provider === envConfig.provider);
          if (!alreadyAdded) {
            missingCredentials.push({ provider: envConfig.provider, service: serverMeta.name });
          }
        }
      }
    }
  }

  return { valid: missingCredentials.length === 0, missingCredentials };
}

/**
 * Formats missing credentials for error display.
 *
 * @param missingCredentials - Array of missing credential info
 * @returns Formatted error message string
 */
export function formatMissingCredentialsError(missingCredentials: MissingCredential[]): string {
  const formattedList = missingCredentials
    .map((c) => `• ${c.service} [provider: ${c.provider}]`)
    .join("\n");

  return `Missing integrations:\n\n${formattedList}\n\nConnect these services before creating workspace.`;
}

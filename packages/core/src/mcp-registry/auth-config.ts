/**
 * Shared helper for building bearer-token auth configuration that bridges
 * Link credential storage to MCP HTTP transport headers.
 *
 * All auth "smarts" live in Link (OAuth flows, token refresh, storage).
 * This helper fabricates the minimal env-var + auth-config pair that
 * `createMCPTools` needs to resolve the token from Link at runtime and
 * pass it as an `Authorization: Bearer` header.
 *
 * @module
 */

import type { LinkCredentialRef } from "@atlas/agent-sdk";
import type { RequiredConfigField } from "./schemas.ts";

export interface BearerAuthConfig {
  type: "bearer";
  token_env: string;
}

/**
 * Build a bearer-token auth bridge for an HTTP MCP server.
 *
 * @param serverId    Kebab-case server identifier (becomes the env-var name)
 * @param providerId  Link provider that owns the OAuth token (may differ from
 *                    serverId when an official shared provider exists, e.g.
 *                    serverId="com-notion-mcp" providerId="notion")
 * @returns `{ auth, env, requiredConfig }` ready to drop into
 *          `MCPServerConfig.configTemplate`
 */
export function buildBearerAuthConfig(
  serverId: string,
  providerId: string,
): {
  auth: BearerAuthConfig;
  env: Record<string, LinkCredentialRef>;
  requiredConfig: RequiredConfigField[];
} {
  const tokenEnvKey = `${serverId.toUpperCase().replace(/-/g, "_")}_ACCESS_TOKEN`;
  return {
    auth: { type: "bearer", token_env: tokenEnvKey },
    env: { [tokenEnvKey]: { from: "link", provider: providerId, key: "access_token" } },
    requiredConfig: [
      {
        key: tokenEnvKey,
        description: `OAuth access token for ${serverId} from Link`,
        type: "string" as const,
      },
    ],
  };
}

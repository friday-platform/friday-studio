/**
 * Agent credential enricher - applies credential bindings to atlas agents
 * Follows same declarative pattern as MCP server enricher
 */

import type { CredentialBinding } from "@atlas/core/artifacts";
import type { ClassifiedAgent } from "../types.ts";

/**
 * Enriches classified agents with resolved Link credential refs.
 * Applies credential bindings declaratively by agentId.
 * Same pattern as mcp-servers.ts enricher.
 *
 * @param agents - Array of classified agent definitions
 * @param credentials - Credential bindings resolved during planning
 * @returns Agents with Link credential refs injected into config
 */
export function enrichAgentCredentials(
  agents: ClassifiedAgent[],
  credentials?: CredentialBinding[],
): ClassifiedAgent[] {
  if (!credentials) return agents;

  return agents.map((agent) => {
    // Filter bindings for this agent
    const bindings = credentials.filter((b) => b.targetType === "agent" && b.agentId === agent.id);
    if (bindings.length === 0) return agent;

    // Apply credential bindings to config
    const enrichedConfig: Record<string, unknown> = { ...agent.config };
    for (const binding of bindings) {
      enrichedConfig[binding.field] = {
        from: "link" as const,
        id: binding.credentialId,
        key: binding.key,
      };
    }

    return { ...agent, config: enrichedConfig };
  });
}

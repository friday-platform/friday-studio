/**
 * MCP server enricher - maps agent needs to MCP server configurations
 * Uses existing deterministic matching from workspace-planner + blessed registry only
 */

import type { MCPServerConfig } from "@atlas/config";
import type { CredentialBinding, WorkspacePlan } from "@atlas/core/artifacts";
import {
  mapNeedToMCPServers,
  matchBundledAgents,
} from "@atlas/core/mcp-registry/deterministic-matching";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";

/**
 * Result type for MCP server generation
 */
export interface MCPServerResult {
  id: string;
  config: MCPServerConfig;
}

/**
 * Generates MCP server configs from agent needs.
 *
 * Credential bindings are pre-resolved by workspace-planner and passed in.
 * This function applies them declaratively by serverId - no Link API calls,
 * no object shape inspection.
 *
 * CRITICAL: Only generates MCP servers for needs NOT satisfied by bundled agents.
 * Bundled agents manage their own MCP connections (e.g., slack bundled agent provides slack-mcp-server).
 *
 * @param agents - Agents from WorkspacePlan
 * @param credentials - Pre-resolved credential bindings from workspace-planner
 * @returns Array of MCP server configs ready for workspace.yml
 */
export function generateMCPServers(
  agents: WorkspacePlan["agents"],
  credentials?: CredentialBinding[],
): MCPServerResult[] {
  // Collect needs from agents that DON'T have bundled agent matches
  const needsForMCP = new Set<string>();

  for (const agent of agents) {
    // Check if this agent is satisfied by a bundled agent
    const bundledMatches = matchBundledAgents(agent.needs);

    if (bundledMatches.length > 0) {
      // Bundled agent provides MCP - skip adding to workspace-level MCP config
      continue;
    }

    // No bundled agent - collect needs for MCP server generation
    for (const need of agent.needs) {
      needsForMCP.add(need);
    }
  }

  const servers: MCPServerResult[] = [];
  const processedServerIds = new Set<string>();

  for (const need of needsForMCP) {
    // Use deterministic matching from blessed registry (same as workspace-planner)
    const mcpMatches = mapNeedToMCPServers(need);

    if (mcpMatches.length > 0) {
      const match = mcpMatches[0];
      if (!match) continue;

      const serverId = match.serverId;

      // Avoid duplicates
      if (processedServerIds.has(serverId)) {
        continue;
      }

      // Get config from blessed registry
      const serverMetadata = mcpServersRegistry.servers[serverId];
      if (serverMetadata?.configTemplate) {
        const config = structuredClone(serverMetadata.configTemplate);

        // Apply credential bindings declaratively
        if (config.env && credentials) {
          for (const binding of credentials.filter(
            (b) => b.targetType === "mcp" && b.serverId === serverId,
          )) {
            config.env[binding.field] = {
              from: "link" as const,
              id: binding.credentialId,
              key: binding.key,
            };
          }
        }

        servers.push({ id: serverId, config });
        processedServerIds.add(serverId);
      }
    }
    // If no match: skip it (might be bundled agent capability or generic LLM capability)
  }

  return servers;
}

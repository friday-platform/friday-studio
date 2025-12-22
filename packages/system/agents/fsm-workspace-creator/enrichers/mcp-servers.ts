/**
 * MCP server enricher - maps agent needs to MCP server configurations
 * Uses existing deterministic matching from workspace-planner + blessed registry only
 */

import type { MCPServerConfig } from "@atlas/config";
import type { WorkspacePlan } from "@atlas/core/artifacts";
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
 * Generates MCP server configs from agent needs
 * Uses blessed registry only (same infrastructure as workspace-planner)
 *
 * CRITICAL: Only generates MCP servers for needs NOT satisfied by bundled agents.
 * Bundled agents manage their own MCP connections (e.g., slack bundled agent provides slack-mcp-server).
 *
 * @param agents - Agents from WorkspacePlan
 * @returns Array of MCP server configs ready for workspace.yml
 */
export function generateMCPServers(agents: WorkspacePlan["agents"]): MCPServerResult[] {
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
        servers.push({ id: serverId, config: serverMetadata.configTemplate });
        processedServerIds.add(serverId);
      }
    }
    // If no match: skip it (might be bundled agent capability or generic LLM capability)
  }

  return servers;
}

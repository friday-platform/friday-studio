/**
 * MCP server enricher - maps agent capability IDs to MCP server configurations
 * via direct registry lookup. No keyword matching or fuzzy search.
 */

import { bundledAgentsRegistry } from "@atlas/bundled-agents/registry";
import type { MCPServerConfig } from "@atlas/config";
import type { CredentialBinding, WorkspacePlan } from "@atlas/core/artifacts";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import type { MCPServerMetadata } from "@atlas/core/mcp-registry/schemas";

/**
 * Result type for MCP server generation
 */
export interface MCPServerResult {
  id: string;
  config: MCPServerConfig;
}

/** Options for generateMCPServers. */
export type GenerateMCPServersOpts = {
  /** Runtime-registered MCP servers from KV (not in the static registry). */
  dynamicServers?: MCPServerMetadata[];
};

/**
 * Generates MCP server configs from agent capability IDs.
 *
 * For each capability ID that exists in the MCP servers registry or dynamic
 * servers (and NOT in the bundled agents registry), generates a server config.
 * Bundled agents manage their own MCP connections internally.
 *
 * Credential bindings are pre-resolved by workspace-planner and passed in.
 * This function applies them declaratively by serverId.
 *
 * @param agents - Agents from WorkspacePlan
 * @param credentials - Pre-resolved credential bindings from workspace-planner
 * @param opts - Optional dynamic servers from KV registry
 * @returns Array of MCP server configs ready for workspace.yml
 */
export function generateMCPServers(
  agents: WorkspacePlan["agents"],
  credentials?: CredentialBinding[],
  opts?: GenerateMCPServersOpts,
): MCPServerResult[] {
  const servers: MCPServerResult[] = [];
  const processedServerIds = new Set<string>();

  const dynamicById = new Map<string, MCPServerMetadata>();
  for (const server of opts?.dynamicServers ?? []) {
    dynamicById.set(server.id, server);
  }

  for (const agent of agents) {
    for (const capabilityId of agent.capabilities) {
      // Skip bundled agent capabilities — they manage their own MCP connections
      if (bundledAgentsRegistry[capabilityId]) continue;

      if (processedServerIds.has(capabilityId)) continue;

      const serverMetadata =
        mcpServersRegistry.servers[capabilityId] ?? dynamicById.get(capabilityId);
      if (!serverMetadata?.configTemplate) continue;

      const config = structuredClone(serverMetadata.configTemplate);

      if (config.env && credentials) {
        for (const binding of credentials.filter(
          (b) => b.targetType === "mcp" && b.serverId === capabilityId,
        )) {
          config.env[binding.field] = {
            from: "link" as const,
            id: binding.credentialId,
            key: binding.key,
          };
        }
      }

      servers.push({ id: capabilityId, config });
      processedServerIds.add(capabilityId);
    }
  }

  return servers;
}

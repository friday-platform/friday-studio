import type { MCPServerConfig } from "@atlas/config";
import { extractKeywordsFromNeed } from "@atlas/core/mcp-registry/deterministic-matching";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";

/**
 * Generates MCP server configurations from domain names.
 * Domains are pre-validated by the planner, so we just look them up in the registry.
 *
 * Handles both keyword domains ("slack") and verbose domains ("slack messaging").
 *
 * @param mcpDomains - Domain names (e.g., ["slack", "github"])
 * @returns Array of MCP server configs
 */
export function generateMCPServers(
  mcpDomains: string[],
): Array<{ id: string; config: MCPServerConfig }> {
  if (mcpDomains.length === 0) {
    return [];
  }

  const mcpServers: Array<{ id: string; config: MCPServerConfig }> = [];
  const processedDomains = new Set<string>();

  for (const domain of mcpDomains) {
    // Extract keywords from verbose domain names (e.g., "slack messaging" → ["slack"])
    const keywords = extractKeywordsFromNeed(domain);

    for (const domainLower of keywords) {
      // Skip duplicates
      if (processedDomains.has(domainLower)) {
        continue;
      }
      processedDomains.add(domainLower);

      // Find MCP server(s) that provide this domain
      for (const [serverId, server] of Object.entries(mcpServersRegistry.servers)) {
        const serverDomains = server.domains.map((d: string) => d.toLowerCase());

        if (serverDomains.includes(domainLower)) {
          // Check if already added (avoid duplicates)
          if (!mcpServers.some((s) => s.id === serverId)) {
            mcpServers.push({ id: serverId, config: server.configTemplate });
          }
        }
      }
    }
  }

  return mcpServers;
}

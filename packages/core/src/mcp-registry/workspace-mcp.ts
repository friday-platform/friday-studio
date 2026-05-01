import type { WorkspaceConfig } from "@atlas/config";
import { findServerReferences, type ServerReference } from "@atlas/config/mutations";
import { discoverMCPServers, type LinkSummary } from "./discovery.ts";
import type { MCPSource } from "./schemas.ts";

// =============================================================================
// TYPES
// =============================================================================

export type { ServerReference };

/** MCP server enriched with workspace-scoped metadata (agent/job assignments). */
export interface EnrichedMCPServer {
  id: string;
  name: string;
  description?: string;
  source: MCPSource;
  configured: boolean;
  agentIds?: string[];
  jobIds?: string[];
}

/** Result of partitioning workspace MCP servers into enabled and available. */
export interface WorkspaceMCPStatus {
  enabled: EnrichedMCPServer[];
  available: EnrichedMCPServer[];
}

// =============================================================================
// PARTITION LOGIC
// =============================================================================

/**
 * Derive the workspace MCP status by partitioning discovered servers into
 * `enabled` (present in workspace config) and `available` (catalog servers not
 * yet enabled).
 *
 * @param workspaceId - Workspace identifier
 * @param workspaceConfig - Pre-loaded workspace configuration
 * @param linkSummary - Optional Link credential summary for `configured` checks
 * @returns Partitioned enabled/available arrays with agent/job references
 */
export async function getWorkspaceMCPStatus(
  workspaceId: string,
  workspaceConfig: WorkspaceConfig,
  linkSummary?: LinkSummary,
): Promise<WorkspaceMCPStatus> {
  const candidates = await discoverMCPServers(workspaceId, workspaceConfig, linkSummary);

  const enabledServerIds = new Set(Object.keys(workspaceConfig.tools?.mcp?.servers ?? {}));

  const enabled: EnrichedMCPServer[] = [];
  const available: EnrichedMCPServer[] = [];

  for (const candidate of candidates) {
    const isEnabled = enabledServerIds.has(candidate.metadata.id);

    if (isEnabled) {
      const refs = findServerReferences(workspaceConfig, candidate.metadata.id);
      const enriched: EnrichedMCPServer = {
        id: candidate.metadata.id,
        name: candidate.metadata.name,
        description: candidate.metadata.description,
        source: candidate.metadata.source,
        configured: candidate.configured,
      };
      if (refs.agentIds.length > 0) enriched.agentIds = refs.agentIds;
      if (refs.jobIds.length > 0) enriched.jobIds = refs.jobIds;
      enabled.push(enriched);
    } else if (candidate.metadata.source === "static" || candidate.metadata.source === "registry") {
      available.push({
        id: candidate.metadata.id,
        name: candidate.metadata.name,
        description: candidate.metadata.description,
        source: candidate.metadata.source,
        configured: candidate.configured,
      });
    }
  }

  return { enabled, available };
}

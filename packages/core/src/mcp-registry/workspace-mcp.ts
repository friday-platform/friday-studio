import type { WorkspaceConfig } from "@atlas/config";
import { discoverMCPServers, type LinkSummary } from "./discovery.ts";

// =============================================================================
// TYPES
// =============================================================================

/** References to a given MCP server found in workspace configuration. */
export interface ServerReference {
  agentIds: string[];
  jobIds: string[];
}

/** MCP server enriched with workspace-scoped metadata (agent/job assignments). */
export interface EnrichedMCPServer {
  id: string;
  name: string;
  description?: string;
  source: "static" | "registry" | "workspace";
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
// REFERENCE WALKER
// =============================================================================

/**
 * Find all workspace agents and FSM job steps that reference a given MCP server.
 *
 * Walks:
 * 1. Top-level LLM agents (`config.agents` with `type === "llm"`), checking
 *    their `config.tools` arrays.
 * 2. FSM job actions (`config.jobs[].fsm.states[].entry[]` with `type === "llm"`),
 *    checking their `tools` arrays.
 *
 * @param config - Workspace configuration to search
 * @param serverId - MCP server identifier to look for
 * @returns Agent and job IDs that reference the server
 */
export function findServerReferences(config: WorkspaceConfig, serverId: string): ServerReference {
  const agentIdSet = new Set<string>();
  const jobIdSet = new Set<string>();

  // 1. Top-level LLM agents
  if (config.agents) {
    for (const [agentId, agentConfig] of Object.entries(config.agents)) {
      if (agentConfig.type !== "llm") continue;
      const tools = agentConfig.config.tools;
      if (tools && tools.includes(serverId)) {
        agentIdSet.add(agentId);
      }
    }
  }

  // 2. FSM job actions
  if (config.jobs) {
    for (const [jobId, rawJob] of Object.entries(config.jobs)) {
      const fsm = (rawJob as Record<string, unknown>)?.fsm;
      if (!fsm || typeof fsm !== "object") continue;

      const states = (fsm as Record<string, unknown>).states;
      if (!states || typeof states !== "object") continue;

      for (const [, state] of Object.entries(states)) {
        if (!state || typeof state !== "object") continue;
        const entry = (state as Record<string, unknown>).entry;
        if (!Array.isArray(entry)) continue;

        for (const action of entry) {
          if (
            action &&
            typeof action === "object" &&
            (action as Record<string, unknown>).type === "llm"
          ) {
            const tools = (action as Record<string, unknown>).tools;
            if (Array.isArray(tools) && tools.includes(serverId)) {
              jobIdSet.add(jobId);
              break;
            }
          }
        }
      }
    }
  }

  return { agentIds: Array.from(agentIdSet), jobIds: Array.from(jobIdSet) };
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
    } else if (candidate.metadata.source !== "workspace") {
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

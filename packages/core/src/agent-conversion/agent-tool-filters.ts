import type { AtlasTools } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";

const DENIED_TOOL_NAMES = new Set([
  // Workspace management tools
  "atlas_workspace_list",
  "atlas_workspace_delete",
  "atlas_workspace_describe",
  "atlas_workspace_set_persistence",
  // Session management tools
  "atlas_session_describe",
  "atlas_session_cancel",
  // Job management tools
  "atlas_workspace_jobs_list",
  "atlas_workspace_jobs_describe",
  "atlas_workspace_job_execute",
  // Signal management tools
  "atlas_workspace_signals_list",
  // Agent management tools
  "atlas_workspace_agents_list",
  "atlas_workspace_agents_describe",
  // Platform metadata
  "system_version",
]);

/**
 * Filters out Atlas platform management tools from the available tool set.
 * This prevents agents from accessing workspace/session/job/signal/agent management
 * and other platform control operations.
 *
 * Agents retain access to:
 * - Library storage (read/write)
 * - Filesystem operations
 * - Artifacts
 * - System tools (bash, csv)
 * - All MCP server tools from external servers
 *
 * @see packages/mcp-server/src/tools/index.ts
 */
export function filterWorkspaceAgentTools(tools: AtlasTools, logger: Logger): AtlasTools {
  const filtered = Object.fromEntries(
    Object.entries(tools).filter(([key]) => !DENIED_TOOL_NAMES.has(key)),
  );
  logger.debug("Filtered tool names for LLM agent", { toolNames: Object.keys(filtered) });
  return filtered;
}

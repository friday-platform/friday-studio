import type { AtlasTools } from "@atlas/agent-sdk";
import { PLATFORM_TOOL_NAMES } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";

export { PLATFORM_TOOL_NAMES };

/**
 * Platform tools that workspace LLM agents are allowed to use.
 * Subset of PLATFORM_TOOL_NAMES — tools NOT in this set are blocked.
 * External MCP server tools always pass through regardless of this list.
 *
 * Keep in sync with:
 * - packages/fsm-engine/fsm-engine.ts (PLATFORM_TOOL_ALLOWLIST)
 * - packages/system/agents/conversation/conversation.agent.ts (ALLOWED_TOOLS)
 */
const LLM_AGENT_ALLOWED_PLATFORM_TOOLS = new Set([
  // Library (read/write)
  "library_list",
  "library_get",
  "library_get_stream",
  "library_store",
  "library_stats",
  "library_templates",
  // Filesystem
  "fs_glob",
  "fs_grep",
  "fs_list_files",
  "fs_read_file",
  "fs_write_file",
  // Artifacts
  "artifacts_create",
  "artifacts_get",
  "artifacts_update",
  "artifacts_get_by_chat",
  "artifacts_delete",
  // System / data processing
  "bash",
  "csv",
  "webfetch",
  // Workspace (limited)
  "convert_task_to_workspace",
  "workspace_signal_trigger",
]);

/**
 * Filters platform tools to only those explicitly allowed for LLM agents.
 * External MCP server tools (not in PLATFORM_TOOL_NAMES) pass through unfiltered.
 *
 * Uses ALLOW list strategy: new platform tools are blocked by default until
 * explicitly added to LLM_AGENT_ALLOWED_PLATFORM_TOOLS.
 *
 * @see packages/mcp-server/src/tools/index.ts — canonical tool registration
 */
export function filterWorkspaceAgentTools(tools: AtlasTools, logger: Logger): AtlasTools {
  const filtered = Object.fromEntries(
    Object.entries(tools).filter(([name]) => {
      const isPlatformTool = PLATFORM_TOOL_NAMES.has(name);
      return !isPlatformTool || LLM_AGENT_ALLOWED_PLATFORM_TOOLS.has(name);
    }),
  );
  logger.debug("Filtered tool names for LLM agent", { toolNames: Object.keys(filtered) });
  return filtered;
}

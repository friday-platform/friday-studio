import { createScratchpadTools } from "./platform-tools/scratchpad-tools.ts";
import type { AgentContext } from "./types.ts";

/**
 * All platform tool names registered by the atlas-platform MCP server.
 * Used to distinguish platform tools (subject to filtering) from external
 * MCP server tools (always passed through).
 *
 * Single source of truth — imported by:
 * - packages/core/src/agent-conversion/agent-tool-filters.ts
 * - packages/fsm-engine/fsm-engine.ts (PLATFORM_TOOL_ALLOWLIST)
 *
 * @see packages/mcp-server/src/tools/index.ts (canonical registration)
 */
export const PLATFORM_TOOL_NAMES = new Set([
  // Workspace management
  "workspace_list",
  "workspace_delete",
  "workspace_describe",
  "workspace_set_persistence",
  "convert_task_to_workspace",
  // Session management
  "session_describe",
  "session_cancel",
  // Job management
  "workspace_jobs_list",
  "workspace_jobs_describe",
  // Signal management
  "workspace_signals_list",
  "workspace_signal_trigger",
  // Agent management
  "workspace_agents_list",
  "workspace_agents_describe",
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
  // State
  "state_append",
  "state_filter",
  "state_lookup",
  // System / data processing
  "bash",
  "csv",
  "system_version",
  "webfetch",
  // Memory
  "memory_save",
  "memory_read",
  "memory_remove",
  // Scratchpad
  "scratchpad_append",
  "scratchpad_read",
  "scratchpad_clear",
]);

export function createPlatformTools(ctx: AgentContext) {
  return { ...createScratchpadTools(ctx) };
}

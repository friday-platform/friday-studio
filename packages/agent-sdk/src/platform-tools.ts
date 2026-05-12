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
  "delete_workspace",
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
  "create_artifact",
  "get_artifact",
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
  // Memory — canonical surface for ephemeral and durable working state.
  // The legacy scratchpad primitive (`{kind, body}` chunks) was removed;
  // agents needing chunked working state use a `short_term` memory store
  // via save_memory_entry / list_memory_entries.
  "save_memory_entry",
  "list_memory_entries",
  "delete_memory_entry",
  // Human-in-the-loop / permissions
  "request_tool_access",
  "request_human_input",
]);

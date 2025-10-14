import type { AtlasTools } from "@atlas/agent-sdk";

const ALLOWED_TOOL_NAMES = new Set([
  "library_list",
  "library_get",
  "library_get_stream",
  "library_store",
  "fs_glob",
  "fs_grep",
  "fs_list_files",
  "fs_read_file",
  "fs_write_file",
  "artifacts_create",
  "artifacts_update",
  "artifacts_get",
  "bash",
]);

/**
 * Refines the list of all tools exposed on the Atlas Platform MCP Server to those relevant for use
 * by agents within a workspace. This means dropping a lot of the 'interact with the platform' tools,
 * such as workspace management and job execution.
 *
 * Generally, agents should only be able to read/write data to Artifact/Library storage plus
 * a carefully selected list of interactivity tools, such as filesystem operations.
 *
 * @see packages/mcp-server/src/tools/index.ts
 */
export function filterWorkspaceAgentTools(tools: AtlasTools): AtlasTools {
  return Object.fromEntries(Object.entries(tools).filter(([key]) => ALLOWED_TOOL_NAMES.has(key)));
}

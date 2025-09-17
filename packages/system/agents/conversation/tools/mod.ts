/**
 * Conversation Agent Tools Module
 *
 * Consolidates all conversation agent tools and exports them as AtlasTools.
 * These tools are used by the conversation agent for:
 * - Streaming events back to the client
 * - Managing conversation storage/history
 * - Todo list management
 * - Resource reading from the platform
 * - Workspace creation and updating
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import { resourceReadTool } from "./resource-read.ts";
import { recallNotesTool, takeNoteTool } from "./scratchpad-tools.ts";
import { tableOutput } from "./table.ts";
import { workspaceMemoryTool } from "./workspace-memory-tool.ts";
import { workspaceSummary } from "./workspace-summary.ts";
// import { updateWorkspace } from "./workspace-update/atlas-update-workspace.ts";

/**
 * All conversation agent tools exported as AtlasTools.
 * These can be spread directly onto the tools object in the agent handler.
 */
export const conversationTools: AtlasTools = {
  atlas_workspace_memory: workspaceMemoryTool,
  take_note: takeNoteTool,
  recall_notes: recallNotesTool,
  read_atlas_resource: resourceReadTool,
  table_output: tableOutput,
  workspace_summary: workspaceSummary,
};

export { workspaceMemoryTool };

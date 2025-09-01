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
import { todoReadTool, todoWriteTool } from "./todo-tools.ts";
import { generateWorkspace } from "./workspace-creation/generation.ts";
import { mcpDiscoveryTool } from "./workspace-creation/mcp-discovery-tool.ts";
import { workspaceMemoryTool } from "./workspace-memory-tool.ts";
import { updateWorkspace } from "./workspace-update/atlas-update-workspace.ts";

/**
 * All conversation agent tools exported as AtlasTools.
 * These can be spread directly onto the tools object in the agent handler.
 */
export const conversationTools: AtlasTools = {
  atlas_workspace_memory: workspaceMemoryTool,
  atlas_todo_read: todoReadTool,
  atlas_todo_write: todoWriteTool,
  read_atlas_resource: resourceReadTool,
  atlas_create_workspace: generateWorkspace,
  atlas_update_workspace: updateWorkspace,
  atlas_discover_mcp_server: mcpDiscoveryTool,
};

export {
  generateWorkspace,
  mcpDiscoveryTool,
  resourceReadTool,
  todoReadTool,
  todoWriteTool,
  updateWorkspace,
  workspaceMemoryTool,
};

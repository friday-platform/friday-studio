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
import { conversationStorageTool } from "./conversation-storage.ts";
import { workspaceMemoryTool } from "./workspace-memory-tool.ts";
import { todoReadTool, todoWriteTool } from "./todo-tools.ts";
import { resourceReadTool } from "./resource-read.ts";
import { streamEvent } from "./stream-event.ts";
import { generateWorkspace } from "./workspace-creation/generation.ts";
import { updateWorkspace } from "./workspace-update/atlas-update-workspace.ts";

/**
 * All conversation agent tools exported as AtlasTools.
 * These can be spread directly onto the tools object in the agent handler.
 */
export const conversationTools: AtlasTools = {
  atlas_stream_event: streamEvent,
  atlas_conversation_storage: conversationStorageTool,
  atlas_workspace_memory: workspaceMemoryTool,
  atlas_todo_read: todoReadTool,
  atlas_todo_write: todoWriteTool,
  read_atlas_resource: resourceReadTool,
  atlas_create_workspace: generateWorkspace,
  atlas_update_workspace: updateWorkspace,
};

export {
  conversationStorageTool,
  generateWorkspace,
  resourceReadTool,
  streamEvent,
  todoReadTool,
  todoWriteTool,
  updateWorkspace,
  workspaceMemoryTool,
};

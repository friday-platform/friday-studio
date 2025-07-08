/**
 * Workspace Draft Management Tools
 *
 * This module exports all draft-related tools for the MCP server.
 * These tools provide comprehensive workspace draft lifecycle management
 * through the Atlas MCP server interface.
 */

export { draftCreateTool } from "./create.ts";
export { draftUpdateTool } from "./update.ts";
export { draftValidateTool } from "./validate.ts";
export { draftPublishTool } from "./publish.ts";
export { draftDeleteTool } from "./delete.ts";
export { draftShowTool } from "./show.ts";
export { draftListTool } from "./list.ts";

// Export all tools as a collection for easy registration
export const draftTools = {
  workspace_draft_create: () => import("./create.ts").then((m) => m.draftCreateTool),
  workspace_draft_update: () => import("./update.ts").then((m) => m.draftUpdateTool),
  workspace_draft_validate: () => import("./validate.ts").then((m) => m.draftValidateTool),
  publish_draft_to_workspace: () => import("./publish.ts").then((m) => m.draftPublishTool),
  delete_draft_config: () => import("./delete.ts").then((m) => m.draftDeleteTool),
  show_draft_config: () => import("./show.ts").then((m) => m.draftShowTool),
  list_session_drafts: () => import("./list.ts").then((m) => m.draftListTool),
};

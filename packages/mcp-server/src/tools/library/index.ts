/**
 * Library management tools for Atlas MCP server
 * These tools provide access to the Atlas library for storing and retrieving
 * reusable resources like reports, templates, and documentation.
 */

import { libraryListTool } from "./list.ts";
import { libraryGetTool } from "./get.ts";
import { libraryStoreTool } from "./store.ts";
import { libraryStatsTool } from "./stats.ts";
import { libraryTemplatesTool } from "./templates.ts";

// Re-export individual tools
export { libraryListTool } from "./list.ts";
export { libraryGetTool } from "./get.ts";
export { libraryStoreTool } from "./store.ts";
export { libraryStatsTool } from "./stats.ts";
export { libraryTemplatesTool } from "./templates.ts";

// Export all tools as an array for easy registration
export const libraryTools = [
  libraryListTool,
  libraryGetTool,
  libraryStoreTool,
  libraryStatsTool,
  libraryTemplatesTool,
] as const;

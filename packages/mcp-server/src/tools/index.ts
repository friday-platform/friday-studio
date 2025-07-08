/**
 * Tool registry for MCP server
 * Centralizes tool registration and management
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext, ToolHandler } from "./types.ts";
import { z } from "zod/v4";

// Import workspace tools
import { workspaceListTool } from "./workspace/list.ts";
import { workspaceCreateTool } from "./workspace/create.ts";
import { workspaceDeleteTool } from "./workspace/delete.ts";
import { workspaceDescribeTool } from "./workspace/describe.ts";

// Import session tools
import { sessionDescribeTool } from "./session/describe.ts";
import { sessionCancelTool } from "./session/cancel.ts";

// Import job tools
import { jobsListTool } from "./jobs/list.ts";
import { jobsDescribeTool } from "./jobs/describe.ts";

// Import signal tools
import { signalsListTool } from "./signals/list.ts";
import { signalsTriggerTool } from "./signals/trigger.ts";

// Import agent tools
import { agentsListTool } from "./agents/list.ts";
import { agentsDescribeTool } from "./agents/describe.ts";

// Import library tools
import { libraryListTool } from "./library/list.ts";
import { libraryGetTool } from "./library/get.ts";
import { libraryStoreTool } from "./library/store.ts";
import { libraryStatsTool } from "./library/stats.ts";
import { libraryTemplatesTool } from "./library/templates.ts";

// Import draft tools
import { draftCreateTool } from "./drafts/create.ts";
import { draftUpdateTool } from "./drafts/update.ts";
import { draftValidateTool } from "./drafts/validate.ts";
import { draftPublishTool } from "./drafts/publish.ts";
import { draftShowTool } from "./drafts/show.ts";
import { draftListTool } from "./drafts/list.ts";
import { draftDeleteTool } from "./drafts/delete.ts";

// Import filesystem tools
import { editTool } from "./edit.ts";
import { globTool } from "./glob.ts";
import { grepTool } from "./grep.ts";
import { lsTool } from "./ls.ts";
import { readTool } from "./read.ts";
import { webfetchTool } from "./webfetch.ts";
import { writeTool } from "./write.ts";

/**
 * Get all available tools
 */
export function getAllTools(): ToolHandler[] {
  return [
    // Workspace tools
    workspaceListTool,
    workspaceCreateTool,
    workspaceDeleteTool,
    workspaceDescribeTool,

    // Session tools
    sessionDescribeTool,
    sessionCancelTool,

    // Job tools
    jobsListTool,
    jobsDescribeTool,

    // Signal tools
    signalsListTool,
    signalsTriggerTool,

    // Agent tools
    agentsListTool,
    agentsDescribeTool,

    // Library tools
    libraryListTool,
    libraryGetTool,
    libraryStoreTool,
    libraryStatsTool,
    libraryTemplatesTool,

    // Draft tools
    draftCreateTool,
    draftUpdateTool,
    draftValidateTool,
    draftPublishTool,
    draftShowTool,
    draftListTool,
    draftDeleteTool,

    // Filesystem tools
    editTool,
    globTool,
    grepTool,
    lsTool,
    readTool,
    webfetchTool,
    writeTool,
  ];
}

/**
 * Register all tools with the MCP server
 */
export function registerTools(server: McpServer, context: ToolContext): void {
  const tools = getAllTools();

  for (const tool of tools) {
    // Extract the shape from the Zod object schema
    // The MCP SDK expects a ZodRawShape (object with Zod schemas as values)
    // not a ZodObject schema
    let inputSchema: z.ZodRawShape;

    if (tool.inputSchema instanceof z.ZodObject) {
      // If it's a ZodObject, extract the shape
      inputSchema = tool.inputSchema.shape;
    } else {
      // Otherwise, assume it's already a raw shape (shouldn't happen with our current setup)
      inputSchema = tool.inputSchema as unknown as z.ZodRawShape;
    }

    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema,
      },
      (args) => tool.handler(args, context),
    );

    context.logger.debug(`Registered tool: ${tool.name}`);
  }

  context.logger.info(`Registered ${tools.length} tools with MCP server`);
}

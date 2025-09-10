/**
 * Tool registry for MCP server
 * Centralizes tool registration and management
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// Import agent tools
import { registerAgentsDescribeTool } from "./agents/describe.ts";
import { registerAgentsListTool } from "./agents/list.ts";
// Import filesystem tools
import { registerGlobTool } from "./fs/glob.ts";
import { registerGrepTool } from "./fs/grep.ts";
import { registerLsTool } from "./fs/ls.ts";
import { registerReadTool } from "./fs/read.ts";
import { registerWriteTool } from "./fs/write.ts";

// Import job tools
import { registerJobsDescribeTool } from "./jobs/describe.ts";
import { registerJobsListTool } from "./jobs/list.ts";
// Import library tools
import { registerLibraryGetTool } from "./library/get.ts";
import { registerLibraryGetStreamTool } from "./library/get-stream.ts";
import { registerLibraryListTool } from "./library/list.ts";
import { registerLibraryStatsTool } from "./library/stats.ts";
import { registerLibraryStoreTool } from "./library/store.ts";
import { registerLibraryTemplatesTool } from "./library/templates.ts";
// Import notification tools
import { registerEmailNotificationTool } from "./notifications/email.ts";
// Import platform tools
import { registerVersionTool } from "./platform/version.ts";
// Import session tools
import { registerSessionCancelTool } from "./session/cancel.ts";
import { registerSessionDescribeTool } from "./session/describe.ts";
// Import signal tools
import { registerSignalsListTool } from "./signals/list.ts";
import { registerSignalsTriggerTool } from "./signals/trigger.ts";
// Import system tools
import { registerBashTool } from "./system/bash.ts";
import type { ToolContext } from "./types.ts";
// Import workspace tools
import { registerWorkspaceDeleteTool } from "./workspace/delete.ts";
import { registerWorkspaceDescribeTool } from "./workspace/describe.ts";
import { registerWorkspaceListTool } from "./workspace/list.ts";

/**
 * Register all tools with the MCP server
 */
export function registerTools(server: McpServer, context: ToolContext): void {
  // Workspace tools
  registerWorkspaceListTool(server, context);
  registerWorkspaceDeleteTool(server, context);
  registerWorkspaceDescribeTool(server, context);

  // Session tools
  registerSessionDescribeTool(server, context);
  registerSessionCancelTool(server, context);

  // Job tools
  registerJobsListTool(server, context);
  registerJobsDescribeTool(server, context);

  // Signal tools
  registerSignalsListTool(server, context);
  registerSignalsTriggerTool(server, context);

  // Agent tools
  registerAgentsListTool(server, context);
  registerAgentsDescribeTool(server, context);

  // Library tools
  registerLibraryListTool(server, context);
  registerLibraryGetTool(server, context);
  registerLibraryGetStreamTool(server, context);
  registerLibraryStoreTool(server, context);
  registerLibraryStatsTool(server, context);
  registerLibraryTemplatesTool(server, context);

  // Filesystem tools
  registerGlobTool(server, context);
  registerGrepTool(server, context);
  registerLsTool(server, context);
  registerReadTool(server, context);
  registerWriteTool(server, context);

  // System tools
  registerBashTool(server, context);

  // Notification tools
  registerEmailNotificationTool(server, context);

  registerVersionTool(server, context);

  context.logger.info("Registered all tools with MCP server");
}

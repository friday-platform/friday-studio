/**
 * Tool registry for MCP server
 * Centralizes tool registration and management
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// Import agent tools
import { registerAgentsDescribeTool } from "./agents/describe.ts";
import { registerAgentsListTool } from "./agents/list.ts";
import { registerArtifactsCreateTool } from "./artifacts/create.ts";
import { registerArtifactsGetTool } from "./artifacts/get.ts";
import { registerArtifactsGetByChatTool } from "./artifacts/get-by-chat.ts";
import { registerArtifactsUpdateTool } from "./artifacts/update.ts";
// Data processing tools
import { registerCsvTool } from "./data-processing/csv/index.ts";
import { registerFetchTool } from "./fetch.ts";
// Import filesystem tools
import { registerGlobTool } from "./fs/glob.ts";
import { registerGrepTool } from "./fs/grep.ts";
import { registerLsTool } from "./fs/ls.ts";
import { registerReadTool } from "./fs/read.ts";
import { registerWriteTool } from "./fs/write.ts";
// Import job tools
import { registerJobsDescribeTool } from "./jobs/describe.ts";
import { registerJobsListTool } from "./jobs/list.ts";
// Import memory tools
import { registerMemoryReadTool } from "./memory/read.ts";
import { registerMemoryRemoveTool } from "./memory/remove.ts";
import { registerMemorySaveTool } from "./memory/save.ts";
// Import platform tools
import { registerVersionTool } from "./platform/version.ts";
// Import session tools
import { registerSessionCancelTool } from "./session/cancel.ts";
import { registerSessionDescribeTool } from "./session/describe.ts";
// Import signal tools
import { registerSignalsListTool } from "./signals/list.ts";
import { registerSignalTriggerTool } from "./signals/trigger.ts";
// Import state tools
import { registerStateAppendTool } from "./state/append.ts";
import { registerStateFilterTool } from "./state/filter.ts";
import { registerStateLookupTool } from "./state/lookup.ts";
// Import system tools
import { registerBashTool } from "./system/bash.ts";
import type { ToolContext } from "./types.ts";
// Import workspace tools
import { registerConvertTaskToWorkspaceTool } from "./workspace/convert-task-to-workspace.ts";
import { registerWorkspaceDeleteTool } from "./workspace/delete.ts";
import { registerWorkspaceDescribeTool } from "./workspace/describe.ts";
import { registerWorkspaceListTool } from "./workspace/list.ts";
import { registerWorkspacePersistenceTool } from "./workspace/persistence.ts";

/**
 * Register all tools with the MCP server
 */
export function registerTools(server: McpServer, context: ToolContext): void {
  // Workspace tools
  registerWorkspaceListTool(server, context);
  registerWorkspaceDeleteTool(server, context);
  registerWorkspaceDescribeTool(server, context);
  registerWorkspacePersistenceTool(server, context);
  registerConvertTaskToWorkspaceTool(server, context);

  // Session tools
  registerSessionDescribeTool(server, context);
  registerSessionCancelTool(server, context);

  // Job tools
  registerJobsListTool(server, context);
  registerJobsDescribeTool(server, context);

  // Signal tools
  registerSignalsListTool(server, context);
  registerSignalTriggerTool(server, context);

  // Agent tools
  registerAgentsListTool(server, context);
  registerAgentsDescribeTool(server, context);

  // Filesystem tools
  registerGlobTool(server);
  registerGrepTool(server);
  registerLsTool(server);
  registerReadTool(server);
  registerWriteTool(server);

  // Data processing tools
  registerCsvTool(server, context);

  // Artifact tools
  registerArtifactsCreateTool(server, context);
  registerArtifactsUpdateTool(server, context);
  registerArtifactsGetTool(server, context);
  registerArtifactsGetByChatTool(server, context);

  // State tools
  registerStateAppendTool(server, context);
  registerStateFilterTool(server, context);
  registerStateLookupTool(server, context);

  // Memory tools — adapter-agnostic
  registerMemorySaveTool(server, context);
  registerMemoryReadTool(server, context);
  registerMemoryRemoveTool(server, context);

  // System tools
  registerBashTool(server, context);

  registerVersionTool(server);

  registerFetchTool(server, context);

  context.logger.info("Registered all tools with MCP server");
}

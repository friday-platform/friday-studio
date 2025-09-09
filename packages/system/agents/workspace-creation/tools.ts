import type { AtlasTools } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import type { WorkspaceBuilder } from "./builder.ts";
import { getGenerateAgentsTool } from "./tools/generate-agents.ts";
import { getGenerateJobsTool } from "./tools/generate-jobs.ts";
import { getGenerateMCPServersTool } from "./tools/generate-mcp-servers.ts";
import { getGenerateSignalsTool } from "./tools/generate-signals.ts";
import { getRemoveJobTool } from "./tools/remove-job.ts";
import { getSetWorkspaceIdentityTool } from "./tools/set-workspace-identity.ts";
import { getValidateWorkspaceTool } from "./tools/validate-workspace.ts";
import { getExportWorkspaceTool, getGetSummaryTool } from "./tools/workspaceUtils.ts";

/**
 * Gets all tools for workspace creation.
 * Tools handle signals, agents, jobs, MCP servers, validation, and export.
 */
export function getWorkspaceBuilderTools(
  builder: WorkspaceBuilder,
  logger: Logger,
  abortSignal?: AbortSignal,
): AtlasTools {
  return {
    setWorkspaceIdentity: getSetWorkspaceIdentityTool(builder),
    generateSignals: getGenerateSignalsTool(builder, logger, abortSignal),
    generateAllAgents: getGenerateAgentsTool(builder, logger, abortSignal),
    generateJobs: getGenerateJobsTool(builder, logger, abortSignal),
    removeJob: getRemoveJobTool(builder, logger),
    generateMCPServers: getGenerateMCPServersTool(builder, logger, abortSignal),
    validateWorkspace: getValidateWorkspaceTool(builder, logger),
    exportWorkspace: getExportWorkspaceTool(builder, logger),
    getSummary: getGetSummaryTool(builder),
  };
}

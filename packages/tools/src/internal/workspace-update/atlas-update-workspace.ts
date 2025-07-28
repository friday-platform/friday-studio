import { z } from "zod/v4";
import { tool } from "ai";
import { WorkspaceUpdater } from "./workspace-updater.ts";
import { defaultContext, fetchWithTimeout, handleDaemonResponse } from "../../utils.ts";

/**
 * Main production tool for workspace updates
 *
 * This tool provides the primary interface for conversation agents to update
 * existing Atlas workspace configurations using AI orchestration with the
 * Generate-Validate-Repair loop.
 */
export const updateWorkspace = tool({
  description:
    "Update existing Atlas workspace using AI orchestration with natural language instructions",
  inputSchema: z.object({
    workspaceIdentifier: z.string().describe(
      "Workspace identifier (ID, name, or path) to update",
    ),
    userIntent: z.string().describe(
      "User's natural language description of the changes they want to make to the workspace",
    ),
    conversationContext: z.string().optional().describe(
      "Additional context from the conversation that provides relevant details",
    ),
    debugLevel: z.enum(["minimal", "detailed"]).default("minimal").describe(
      "Level of technical detail to include in the response",
    ),
    applyChanges: z.boolean().default(true).describe(
      "Whether to apply changes to the workspace files (true) or just generate updated config (false)",
    ),
  }),
  execute: async (
    { workspaceIdentifier, userIntent, conversationContext, debugLevel, applyChanges },
  ) => {
    const updater = new WorkspaceUpdater();

    try {
      // Step 1: Update workspace configuration using AI orchestration
      const { config, reasoning, workspace } = await updater.updateWorkspace(
        workspaceIdentifier,
        userIntent,
        conversationContext,
        3, // maxAttempts
      );

      // Step 2: Apply changes to workspace if requested
      if (applyChanges) {
        try {
          const response = await fetchWithTimeout(
            `${defaultContext.daemonUrl}/api/workspaces/${workspace.id}/update`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                config,
                backup: true, // Always create backup before updating
              }),
            },
          );

          const updateResult = await handleDaemonResponse(response) as {
            workspace: unknown;
            backupPath?: string;
            filesModified: string[];
            reloadRequired: boolean;
          };

          return {
            success: true,
            config,
            reasoning: debugLevel === "detailed" ? reasoning : "Workspace updated successfully",
            workspaceName: config.workspace.name,
            workspaceId: workspace.id,
            applied: true,
            workspace: updateResult.workspace,
            backupPath: updateResult.backupPath,
            filesModified: updateResult.filesModified,
            reloadRequired: updateResult.reloadRequired,
            summary: {
              signals: Object.keys(config.signals || {}).length,
              agents: Object.keys(config.agents || {}).length,
              jobs: Object.keys(config.jobs || {}).length,
              mcpServers: config.tools?.mcp?.servers
                ? Object.keys(config.tools.mcp.servers).length
                : 0,
            },
          };
        } catch (updateError) {
          // Return update success but application failure
          throw new Error(
            `Workspace updated successfully but application failed: ${
              updateError instanceof Error ? updateError.message : String(updateError)
            }`,
          );
        }
      }

      // Update only (applyChanges = false)
      return {
        success: true,
        config,
        reasoning: debugLevel === "detailed" ? reasoning : "Workspace updated successfully",
        workspaceName: config.workspace.name,
        workspaceId: workspace.id,
        applied: false,
        summary: {
          signals: Object.keys(config.signals || {}).length,
          agents: Object.keys(config.agents || {}).length,
          jobs: Object.keys(config.jobs || {}).length,
          mcpServers: config.tools?.mcp?.servers ? Object.keys(config.tools.mcp.servers).length : 0,
        },
      };
    } catch (error) {
      const errorMessage = debugLevel === "detailed"
        ? (error instanceof Error ? error.message : String(error))
        : getUserFriendlyError(error);
      throw new Error(
        `Workspace update failed: ${errorMessage}`,
      );
    }
  },
});

/**
 * Convert technical errors into user-friendly messages
 */
function getUserFriendlyError(error: unknown): string {
  if (error instanceof Error) {
    // Handle specific error patterns
    if (error.message.includes("not found")) {
      return "The specified workspace could not be found. Please check the workspace identifier.";
    }
    if (error.message.includes("validation")) {
      return "The workspace update had validation issues. Please try with different modifications or contact support if this persists.";
    }
    if (error.message.includes("ANTHROPIC_API_KEY")) {
      return "AI service is not properly configured. Please contact your administrator.";
    }
    if (error.message.includes("tool")) {
      return "There was an issue with workspace modification. Please try again with a clearer description.";
    }
    if (error.message.includes("Failed after")) {
      return "The workspace update couldn't complete successfully. Please try simplifying your requirements or providing more specific details.";
    }

    // Return the actual error message for debugging but make it user-friendly
    return error.message;
  }

  return "An unexpected error occurred during workspace update. Please try again.";
}

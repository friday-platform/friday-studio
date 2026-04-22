/**
 * Workspace conversion tool - converts task execution results to reusable workspaces
 *
 * Takes a successful task execution (with FSM definition and MCP servers)
 * and converts it into a full workspace with signals.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse } from "../utils.ts";

export function registerConvertTaskToWorkspaceTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "convert_task_to_workspace",
    {
      description:
        "Convert a successful task execution into a reusable workspace with signals. " +
        "Use the artifactId from a delegate or agent_<id> tool response to reference the task execution.",
      inputSchema: {
        taskResultId: z
          .string()
          .describe(
            "Task execution result ID (artifact ID from a delegate or agent_<id> tool response)",
          ),
        workspaceName: z.string().describe("Name for the new workspace"),
        signalType: z
          .enum(["http", "schedule"])
          .optional()
          .default("http")
          .describe("How to trigger the workspace (default: http)"),
        signalConfig: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Signal configuration (e.g., {cron: '0 9 * * *'} for schedule)"),
      },
    },
    ({ taskResultId, workspaceName, signalType }) => {
      ctx.logger.info("convert_task_to_workspace called", {
        taskResultId,
        workspaceName,
        signalType,
      });

      try {
        // TODO: Implement workspace conversion
        // 1. Load task result from artifact storage
        // 2. Build workspace plan from task result
        // 3. Enrich signal based on signal type
        // 4. Generate workspace.yml using buildWorkspaceConfig()
        // 5. Write files to ~/.atlas/workspaces/{workspace-name}/
        // 6. Register workspace via daemon API

        ctx.logger.info("Workspace conversion not yet implemented", { taskResultId });

        return createErrorResponse(
          "Workspace conversion feature not yet fully implemented. " +
            "FSM-based execution is working, workspace conversion coming soon.",
          {
            taskResultId,
            workspaceName,
            signalType,
            note: "You can manually create a workspace using the FSM definition from the task result",
          },
        );
      } catch (error) {
        ctx.logger.error("Workspace conversion failed", { error });
        return createErrorResponse(
          `Workspace conversion failed: ${error instanceof Error ? error.message : String(error)}`,
          { taskResultId, workspaceName },
        );
      }
    },
  );
}

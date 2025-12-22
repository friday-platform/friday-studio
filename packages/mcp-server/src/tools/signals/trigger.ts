/**
 * Signal trigger tool for MCP server
 * Triggers a signal on a workspace through the daemon API
 */

import { client, parseResult } from "@atlas/client/v2";
import { validateSignalPayload } from "@atlas/config";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../types.ts";
import { createErrorResponse, createSuccessResponse } from "../utils.ts";

export function registerSignalTriggerTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "atlas_workspace_signal_trigger",
    {
      description:
        "Trigger a signal on a workspace to initiate automated job execution. This directly invokes the signal without using shell commands, providing better error handling and integration.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID to trigger the signal on"),
        signalId: z.string().describe("Signal ID to trigger"),
        payload: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional payload data to send with the signal"),
      },
    },
    async ({ workspaceId, signalId, payload }) => {
      ctx.logger.info("MCP workspace_signal_trigger called", {
        workspaceId,
        signalId,
        hasPayload: !!payload,
      });

      // Validate payload against signal schema
      try {
        const wsResult = await parseResult(
          client.workspace[":workspaceId"].$get({ param: { workspaceId } }),
        );

        if (wsResult.ok) {
          const signalConfig = wsResult.data.config?.signals?.[signalId];
          if (signalConfig) {
            const validation = validateSignalPayload(signalConfig, payload);
            if (!validation.success) {
              ctx.logger.error("Signal payload validation failed", {
                workspaceId,
                signalId,
                error: validation.error,
                providedFields: payload ? Object.keys(payload) : [],
                requiredFields: signalConfig.schema?.required,
              });
              return createErrorResponse(`Payload validation failed: ${validation.error}`);
            }
            ctx.logger.debug("Signal payload validated", { workspaceId, signalId });
          }
        }
      } catch (validationError) {
        ctx.logger.warn("Could not validate signal payload (proceeding anyway)", {
          workspaceId,
          signalId,
          error: validationError,
        });
      }

      try {
        const result = await parseResult(
          client.workspace[":workspaceId"].signals[":signalId"].$post({
            param: { workspaceId, signalId },
            json: { payload: payload || {} },
          }),
        );

        if (!result.ok) {
          ctx.logger.error("Failed to trigger signal", {
            workspaceId,
            signalId,
            error: result.error,
          });
          return createErrorResponse(
            `Failed to trigger signal '${signalId}' on workspace '${workspaceId}': ${result.error}`,
          );
        }

        const response = result.data;

        ctx.logger.info("Signal triggered successfully", {
          workspaceId,
          signalId,
          sessionId: response.sessionId,
        });

        return createSuccessResponse({
          workspaceId,
          signalId,
          sessionId: response.sessionId,
          status: "triggered",
          message: `Signal '${signalId}' triggered successfully on workspace '${workspaceId}'`,
        });
      } catch (error) {
        ctx.logger.error("Error triggering signal", { workspaceId, signalId, error });
        return createErrorResponse(
          `Error triggering signal '${signalId}' on workspace '${workspaceId}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}

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
import { hasArtifactRefFields, resolveArtifactRefs } from "./resolve-artifact-refs.ts";

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
          .describe(
            "Optional payload data to send with the signal. For fields with format 'artifact-ref', pass the bare artifact UUID (e.g. '4a3e2c5b-f352-4882-904b-bb479afa6322'). Do NOT add prefixes like 'artifact:' or 'cortex://'.",
          ),
        // Session context injected by callers - we extract datetime for timezone-aware signals
        _sessionContext: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async ({ workspaceId, signalId, payload: rawPayload, _sessionContext }) => {
      // Extract datetime and streamId from session context
      const datetime = _sessionContext?.datetime;
      const streamId =
        typeof _sessionContext?.streamId === "string" ? _sessionContext.streamId : undefined;
      let payload = rawPayload;

      ctx.logger.info("MCP workspace_signal_trigger called", {
        workspaceId,
        signalId,
        hasPayload: !!payload,
        hasDatetime: !!datetime,
      });

      // Validate payload against signal schema
      try {
        const wsResult = await parseResult(
          client.workspace[":workspaceId"].$get({ param: { workspaceId } }),
        );

        if (wsResult.ok) {
          const signalConfig = wsResult.data.config?.signals?.[signalId];
          if (signalConfig) {
            // Resolve artifact-ref fields before validation
            if (signalConfig.schema && streamId && hasArtifactRefFields(signalConfig.schema)) {
              try {
                const artifactsResponse = await parseResult(
                  client.artifactsStorage.index.$get({
                    query: { chatId: streamId, limit: "1000" },
                  }),
                );
                if (!artifactsResponse.ok) {
                  ctx.logger.error("Failed to fetch artifacts for reference resolution", {
                    workspaceId,
                    signalId,
                    error: artifactsResponse.error,
                  });
                  return createErrorResponse(
                    `Cannot resolve artifact references: failed to fetch artifacts from chat`,
                  );
                }
                const resolution = resolveArtifactRefs(
                  signalConfig.schema,
                  payload ?? {},
                  artifactsResponse.data.artifacts,
                );
                if (!resolution.success) {
                  ctx.logger.error("Artifact reference resolution failed", {
                    workspaceId,
                    signalId,
                    error: resolution.error,
                  });
                  return createErrorResponse(
                    `Artifact reference resolution failed: ${resolution.error}`,
                  );
                }
                payload = resolution.payload;
              } catch (artifactError) {
                ctx.logger.error("Failed to fetch artifacts for reference resolution", {
                  workspaceId,
                  signalId,
                  error: artifactError,
                });
                return createErrorResponse(
                  `Cannot resolve artifact references: failed to fetch artifacts from chat`,
                );
              }
            }

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
        // Merge datetime into payload for timezone-aware FSM agents
        const enrichedPayload = datetime ? { ...payload, datetime } : payload || {};

        const result = await parseResult(
          client.workspace[":workspaceId"].signals[":signalId"].$post({
            param: { workspaceId, signalId },
            json: { payload: enrichedPayload },
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

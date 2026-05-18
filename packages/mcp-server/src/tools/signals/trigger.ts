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

/**
 * Response shape returned in a 2xx body by `POST /api/workspaces/:ws/signals/:sig`.
 * Atlasd emits exactly two shapes today:
 *   - `completed` — synchronous mode, cascade ran to completion
 *   - `accepted`  — `?nowait=true` or webhook mode, cascade dispatched async
 *
 * Terminal failures (workspace error, cascade reject, etc.) come back as
 * non-2xx and surface here via `result.ok === false` from `parseResult`,
 * not as a `status: "failed"` body. Keep this union tight to what atlasd
 * actually emits — a wider union would only protect a hypothetical
 * contract.
 *
 * Source of truth for these shapes: apps/atlasd/routes/workspaces/index.ts
 * (search for `status: "completed"` and `status: "accepted"`). MCP tools
 * are reached by LLM clients, so silent shape drift here would be the
 * highest-stakes path among the four discriminator call sites — the Zod
 * parse in the handler catches it at runtime.
 */
export const SignalTriggerResponseSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    sessionId: z.string(),
    output: z.unknown().optional(),
    summary: z.string().optional(),
  }),
  z.object({ status: z.literal("accepted"), correlationId: z.string() }),
]);
export type SignalTriggerResponse = z.infer<typeof SignalTriggerResponseSchema>;

/**
 * Pure function — maps an atlasd signal-trigger response into the MCP
 * tool's response envelope. Extracted so the discriminator behavior is
 * unit-testable without standing up the full Hono RPC + MCP server stack.
 */
export function mapSignalTriggerResponse(
  workspaceId: string,
  signalId: string,
  response: SignalTriggerResponse,
): { kind: "success"; payload: Record<string, unknown> } {
  if (response.status === "completed") {
    return {
      kind: "success",
      payload: {
        workspaceId,
        signalId,
        sessionId: response.sessionId,
        status: "triggered" as const,
        message: `Signal '${signalId}' triggered successfully on workspace '${workspaceId}'`,
      },
    };
  }
  // status === "accepted" (exhaustive — TS narrows after the if above)
  return {
    kind: "success",
    payload: {
      workspaceId,
      signalId,
      status: "accepted" as const,
      correlationId: response.correlationId,
      message: `Signal '${signalId}' accepted on workspace '${workspaceId}' (async).`,
    },
  };
}

export function registerSignalTriggerTool(server: McpServer, ctx: ToolContext) {
  server.registerTool(
    "workspace_signal_trigger",
    {
      description:
        "Trigger a signal on a workspace to initiate automated job execution. This directly invokes the signal without using shell commands, providing better error handling and integration.",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID to trigger the signal on"),
        signalId: z
          .string()
          .describe(
            "Signal ID to trigger (obtain from workspace_describe or workspace_signals_list)",
          ),
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

        // Runtime-validate atlasd's response shape at the seam instead
        // of `as`-casting. Schema drift (renamed field, new status) gets
        // caught here with a clear error instead of feeding a malformed
        // envelope to the LLM client.
        const parsed = SignalTriggerResponseSchema.safeParse(result.data);
        if (!parsed.success) {
          ctx.logger.error("Atlasd signal-trigger response shape drifted", {
            workspaceId,
            signalId,
            zodError: parsed.error.message,
            rawData: result.data,
          });
          return createErrorResponse(
            `Atlasd returned an unexpected signal-trigger response shape — ` +
              `the MCP tool's contract assumes status ∈ {completed, accepted} ` +
              `but got: ${parsed.error.message}`,
          );
        }
        const mapped = mapSignalTriggerResponse(workspaceId, signalId, parsed.data);
        if (mapped.payload.status === "accepted") {
          ctx.logger.warn("Signal trigger returned non-completed status", mapped.payload);
        } else {
          ctx.logger.info("Signal triggered successfully", mapped.payload);
        }
        return createSuccessResponse(mapped.payload);
      } catch (error) {
        ctx.logger.error("Error triggering signal", { workspaceId, signalId, error });
        return createErrorResponse(
          `Error triggering signal '${signalId}' on workspace '${workspaceId}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  );
}

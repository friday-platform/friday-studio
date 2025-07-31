import { daemonFactory } from "../../src/factory.ts";
import { describeRoute, resolver, validator } from "hono-openapi";
import { SignalTriggerRequestSchema } from "@atlas/config";
import { AtlasTelemetry } from "../../../../src/utils/telemetry.ts";
import { AtlasLogger } from "../../../../src/utils/logger.ts";
import { errorResponseSchema, signalPathSchema, signalTriggerResponseSchema } from "./schemas.ts";

const triggerSignal = daemonFactory.createApp();

triggerSignal.post(
  "/",
  describeRoute({
    tags: ["Signals"],
    summary: "Trigger workspace signal",
    description: `
Triggers a signal within a specific workspace. Signals are defined in the workspace's
configuration and can have different payload requirements. The streamId parameter
enables real-time progress feedback in the UI.

**Dynamic Behavior:**
- Workspace is resolved by ID or name at runtime
- Signal availability depends on workspace configuration
- Payload schema varies by signal type
- Session progress streamed via streamId (optional)
    `.trim(),
    responses: {
      200: {
        description: "Signal accepted for processing",
        content: {
          "application/json": {
            schema: resolver(signalTriggerResponseSchema),
          },
        },
      },
      400: {
        description: "Invalid request body or signal configuration",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
      404: {
        description: "Workspace or signal not found",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
      500: {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  validator("param", signalPathSchema),
  validator("json", SignalTriggerRequestSchema),
  async (c) => {
    const { workspaceId, signalId } = c.req.valid("param");
    const { payload } = c.req.valid("json");

    const ctx = c.get("app");

    return await AtlasTelemetry.withServerSpan(
      "POST /api/workspaces/:workspaceId/signals/:signalId",
      async (span) => {
        const logger = AtlasLogger.getInstance();
        AtlasTelemetry.addComponentAttributes(span, "signal", {
          id: signalId,
          workspaceId,
          type: "daemon",
        });

        try {
          // Get or create workspace runtime (handles dynamic workspace resolution)
          const runtime = await ctx.getOrCreateWorkspaceRuntime(workspaceId);

          // Use triggerSignalWithSession to get the session back (handles config resolution internally)
          const session = await runtime.triggerSignalWithSession(
            signalId,
            payload || {},
          );

          // Update lastSeen timestamp after signal processing
          try {
            const manager = ctx.getWorkspaceManager();
            await manager.updateWorkspaceLastSeen(workspaceId);
          } catch (error) {
            // Log but don't fail the request - lastSeen update is not critical
            logger.warn(`Failed to update lastSeen for workspace ${workspaceId}`, { error });
          }

          // Reset idle timeout for this workspace
          ctx.resetIdleTimeout(workspaceId);

          return c.json({
            message: "Signal accepted for processing",
            status: "processing" as const,
            workspaceId,
            signalId,
            sessionId: session.id,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(errorMessage);

          // Handle specific error types
          if (errorMessage.includes("Workspace not found")) {
            return c.json(
              { error: `Workspace not found: ${workspaceId}` },
              404,
            );
          }

          if (
            errorMessage.includes("Signal not found") ||
            errorMessage.includes("not found")
          ) {
            return c.json(
              {
                error: `Signal '${signalId}' not found in workspace '${workspaceId}'`,
              },
              404,
            );
          }

          return c.json(
            {
              error: `Failed to process signal: ${errorMessage}`,
            },
            500,
          );
        }
      },
      {
        "http.method": "POST",
        "http.url": `/api/workspaces/${workspaceId}/signals/${signalId}`,
        "signal.id": signalId,
        "workspace.id": workspaceId,
        "payload.size": JSON.stringify(payload || {}).length,
      },
    );
  },
);

export { triggerSignal };

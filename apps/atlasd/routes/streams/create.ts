import { logger } from "@atlas/logger";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod/v4";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";

const createStreamRoute = daemonFactory.createApp();

/**
 * POST / - Create new stream for real-time agent communication.
 *
 * Initializes SSE channel that agents use to stream responses.
 * Optionally triggers workspace signal to start processing immediately.
 */
createStreamRoute.post(
  "/",
  describeRoute({
    tags: ["Streams"],
    summary: "Create a new stream session",
    description: "Creates a new stream session with optional signal triggering",
    responses: {
      200: {
        description: "Stream created successfully",
        content: {
          "application/json": {
            schema: resolver(
              z.object({ success: z.boolean(), stream_id: z.string(), sse_url: z.string() }),
            ),
          },
        },
      },
      400: {
        description: "Invalid request parameters",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator(
    "json",
    z.object({
      streamId: z.string().optional(),
      createOnly: z.boolean().optional().default(false),
      workspaceId: z.string().optional(),
      signal: z.string().optional(),
    }),
  ),
  async (c) => {
    const ctx = c.get("app");
    const body = c.req.valid("json");

    try {
      const streamId = body.streamId || crypto.randomUUID();

      if (!ctx.sseClients.has(streamId)) {
        ctx.sseClients.set(streamId, []);
      }

      logger.info("Stream created", {
        streamId,
        workspaceId: body.workspaceId,
        signal: body.signal,
        createOnly: body.createOnly,
      });

      if (!body.createOnly && body.workspaceId && body.signal) {
        try {
          const runtime = await ctx.getOrCreateWorkspaceRuntime(body.workspaceId);
          await runtime.triggerSignal(body.signal, { streamId, source: "stream-creation" });

          logger.info("Signal triggered for stream", {
            streamId,
            workspaceId: body.workspaceId,
            signal: body.signal,
          });
        } catch (error) {
          logger.error("Failed to trigger signal", {
            streamId,
            workspaceId: body.workspaceId,
            signal: body.signal,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      return c.json({ success: true, stream_id: streamId, sse_url: `/api/sse/${streamId}/stream` });
    } catch (error) {
      logger.error("Failed to create stream", {
        error: error instanceof Error ? error.message : String(error),
      });

      return c.json(
        { error: error instanceof Error ? error.message : "Failed to create stream" },
        500,
      );
    }
  },
);

export { createStreamRoute };

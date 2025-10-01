import { logger } from "@atlas/logger";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";

const sendMessageRoute = daemonFactory.createApp();

/**
 * POST /:streamId - Send user message through stream to trigger agent processing.
 *
 * Routes messages to workspace conversation signal for processing by
 * configured agents. Responses stream back through the SSE channel.
 */
sendMessageRoute.post(
  "/",
  describeRoute({
    tags: ["Streams"],
    summary: "Send a message through the stream",
    description: "Send user message to trigger conversation agent processing",
    responses: {
      200: {
        description: "Message sent successfully",
        content: {
          "application/json": {
            schema: resolver(
              z.object({ success: z.boolean(), message: z.string(), messageId: z.string() }),
            ),
          },
        },
      },
      400: {
        description: "Invalid request parameters",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      404: {
        description: "Stream not found",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("param", z.object({ streamId: z.string() })),
  validator(
    "json",
    z.object({
      message: z.string(),
      userId: z.string().optional().default("cli-user"),
      conversationId: z.string().optional(),
      scope: z.record(z.string(), z.unknown()).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  async (c) => {
    const ctx = c.get("app");
    const { streamId } = c.req.valid("param");
    const body = c.req.valid("json");

    try {
      if (!ctx.sseClients.has(streamId)) {
        return c.json({ error: "Stream not found" }, 404);
      }

      const messageId = crypto.randomUUID();

      logger.info("Processing stream message", {
        streamId,
        messageId,
        userId: body.userId,
        conversationId: body.conversationId,
      });

      const workspaceId = body.scope?.workspaceId || "atlas-conversation";

      try {
        const runtime = await ctx.getOrCreateWorkspaceRuntime(workspaceId);

        await runtime.triggerSignalWithSession(
          "conversation-stream",
          {
            streamId,
            messageId,
            message: body.message,
            userId: body.userId || "cli-user",
            conversationId: body.conversationId,
            scope: body.scope,
            metadata: {
              ...body.metadata,
              source: "stream-message",
              timestamp: new Date().toISOString(),
            },
          },
          streamId,
        );

        logger.info("Message processed and signal triggered", { streamId, messageId, workspaceId });

        return c.json({ success: true, message: "Message sent successfully", messageId });
      } catch (error) {
        logger.error("Failed to process message", { streamId, messageId, error });
        throw error;
      }
    } catch (error) {
      logger.error("Failed to send message", { streamId, error });

      return c.json(
        { error: error instanceof Error ? error.message : "Failed to send message" },
        500,
      );
    }
  },
);

export { sendMessageRoute };

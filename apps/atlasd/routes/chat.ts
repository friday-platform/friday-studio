import process from "node:process";
import { type AtlasUIMessageChunk, validateAtlasUIMessages } from "@atlas/agent-sdk";
import { createAnalyticsClient, EventNames } from "@atlas/analytics";
import { ChatStorage } from "@atlas/core/chat/storage";
import { extractTempestUserId } from "@atlas/core/credentials";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { zValidator } from "@hono/zod-validator";
import { stream } from "hono/streaming";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";

const analytics = createAnalyticsClient();

const chatRequestSchema = z.object({
  id: z.string().min(1),
  message: z.unknown(),
  datetime: z
    .object({
      timezone: z.string(),
      timestamp: z.string(),
      localDate: z.string(),
      localTime: z.string(),
      timezoneOffset: z.string(),
    })
    .optional(),
});
const appendMessageSchema = z.object({ message: z.unknown() });
const updateTitleSchema = z.object({ title: z.string() });
const listChatsQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).optional(),
  cursor: z.coerce.number().optional(),
});

/**
 * Extract userId from ATLAS_KEY JWT.
 * Falls back to "default-user" in dev mode (no ATLAS_KEY).
 */
function getUserId(): string {
  const atlasKey = process.env.ATLAS_KEY;
  return (atlasKey && extractTempestUserId(atlasKey)) || "default-user";
}

const chatRoutes = daemonFactory
  .createApp()
  /**
   * GET /api/chat
   * List recent chats with cursor-based pagination.
   */
  .get("/", zValidator("query", listChatsQuerySchema), async (c) => {
    const { limit, cursor } = c.req.valid("query");
    const result = await ChatStorage.listChats({ limit, cursor });
    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }

    return c.json(result.data, 200);
  })

  /**
   * POST /api/chat
   * Create chat, store message, stream events in response body.
   * Streams newline-delimited JSON events.
   */
  .post("/", zValidator("json", chatRequestSchema), async (c) => {
    const ctx = c.get("app");
    const { id: chatId, message, datetime } = c.req.valid("json");
    const userId = getUserId();
    const workspaceId = c.req.header("X-Workspace-Id") || "atlas-conversation";

    const result = await ChatStorage.createChat({ chatId, userId, workspaceId, source: "atlas" });
    if (!result.ok) {
      return c.json({ error: "Failed to create chat" }, 500);
    }

    analytics.emit({
      eventName: EventNames.CONVERSATION_STARTED,
      userId,
      workspaceId,
      conversationId: chatId,
    });

    // // Validate and parse the message
    const [userMessage] = await validateAtlasUIMessages([message]);
    if (!userMessage) {
      return c.json({ error: "Invalid message format" }, 400);
    }

    const appendResult = await ChatStorage.appendMessage(chatId, userMessage);
    if (!appendResult.ok) {
      return c.json({ error: "Failed to store message" }, 500);
    }

    const runtime = await ctx.getOrCreateWorkspaceRuntime(workspaceId);

    // Initialize stream buffer for resumption support
    ctx.streamRegistry.createStream(chatId);

    // Stream response directly with SSE format
    return stream(c, async (streamWriter) => {
      let sessionComplete = false;

      runtime
        .triggerSignalWithSession(
          "conversation-stream",
          { chatId, message: "", userId, streamId: chatId, datetime },
          chatId,
          async (event: unknown) => {
            const chunk = event as AtlasUIMessageChunk;

            // Buffer event for potential resumption
            ctx.streamRegistry.appendEvent(chatId, chunk);

            // Write to this HTTP connection
            try {
              await streamWriter.write(`data: ${JSON.stringify(event)}\n\n`);
            } catch (error) {
              // Client disconnected - events continue buffering in registry
              logger.debug("Client disconnected during stream", { chatId, error });
            }

            if (chunk.type === "data-session-finish") {
              sessionComplete = true;
            }
          },
        )
        .catch((error) => {
          logger.error("Session error", { error, chatId });
          streamWriter.writeln(
            `data: ${JSON.stringify({
              type: "data-error",
              data: { error: stringifyError(error), errorCause: error },
            })}`,
          );
          streamWriter.writeln("");
          sessionComplete = true;
        })
        .finally(() => {
          ctx.streamRegistry.finishStream(chatId);
        });

      // Keep stream alive until session completes
      while (!sessionComplete) {
        await streamWriter.sleep(100);
      }

      // Send completion marker
      await streamWriter.writeln("data: [DONE]");
      await streamWriter.writeln("");
    });
  })

  /**
   * DELETE /api/chat/:chatId/stream
   * Mark a stream as finished (cosmetic stop).
   *
   * The agent continues running in the background, but the client stops
   * receiving events and the UI shows the conversation as complete.
   * Idempotent - safe to call multiple times.
   */
  .delete("/:chatId/stream", (c) => {
    const ctx = c.get("app");
    const chatId = c.req.param("chatId");

    ctx.streamRegistry.finishStream(chatId);

    return c.json({ success: true }, 200);
  })

  /**
   * GET /api/chat/:chatId/stream
   * Reconnect to an active chat stream for resumption.
   *
   * Returns 200 with SSE stream if active, replaying buffered events.
   * Returns 204 if stream doesn't exist or is finished.
   */
  .get("/:chatId/stream", (c) => {
    const ctx = c.get("app");
    const chatId = c.req.param("chatId");

    const buffer = ctx.streamRegistry.getStream(chatId);

    // No active stream - return 204
    if (!buffer || !buffer.active) {
      return c.body(null, 204);
    }

    // Set header for client-side timer synchronization
    c.header("X-Turn-Started-At", String(buffer.createdAt));

    // Return SSE stream with replay + live events
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const subscribed = ctx.streamRegistry.subscribe(chatId, controller);
        if (!subscribed) {
          controller.close();
          return;
        }

        c.req.raw.signal.addEventListener("abort", () => {
          ctx.streamRegistry.unsubscribe(chatId, controller);
        });
      },
    });

    return c.body(stream, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  })

  /**
   * GET /api/chat/:chatId
   * Retrieve chat metadata and message history.
   */
  .get("/:chatId", async (c) => {
    const chatId = c.req.param("chatId");

    const chatResult = await ChatStorage.getChat(chatId);
    if (!chatResult.ok || !chatResult.data) {
      return c.json({ error: "Chat not found" }, 404);
    }

    const { messages, systemPromptContext, ...chat } = chatResult.data;
    // Return last 100 messages in chronological order (oldest first)
    const limitedMessages = messages.slice(-100);

    return c.json(
      { chat, messages: limitedMessages, systemPromptContext: systemPromptContext ?? null },
      200,
    );
  })

  /**
   * POST /api/chat/:chatId/message
   * Append assistant message to chat history.
   * Called from conversation agent's onFinish callback.
   */
  .post("/:chatId/message", zValidator("json", appendMessageSchema), async (c) => {
    const chatId = c.req.param("chatId");
    const { message } = c.req.valid("json");

    // Verify chat exists
    const chatResult = await ChatStorage.getChat(chatId);
    if (!chatResult.ok || !chatResult.data) {
      return c.json({ error: "Chat not found" }, 404);
    }

    // Validate the message format
    const [validatedMessage] = await validateAtlasUIMessages([message]);
    if (!validatedMessage) {
      return c.json({ error: "Invalid message format" }, 400);
    }

    // Append the assistant message
    const appendResult = await ChatStorage.appendMessage(chatId, validatedMessage);
    if (!appendResult.ok) {
      logger.error("Failed to append assistant message", { chatId, error: appendResult.error });
      return c.json({ error: "Failed to append message" }, 500);
    }

    return c.json({ success: true }, 200);
  })

  /**
   * PATCH /api/chat/:chatId/title
   * Update chat title.
   */
  .patch("/:chatId/title", zValidator("json", updateTitleSchema), async (c) => {
    const chatId = c.req.param("chatId");
    const { title } = c.req.valid("json");

    const result = await ChatStorage.updateChatTitle(chatId, title);
    if (!result.ok) {
      return c.json({ error: result.error }, result.error === "Chat not found" ? 404 : 500);
    }

    return c.json({ chat: result.data }, 200);
  })

  /**
   * DELETE /api/chat/:chatId
   * Delete a chat.
   */
  .delete("/:chatId", async (c) => {
    const chatId = c.req.param("chatId");

    const result = await ChatStorage.deleteChat(chatId);
    if (!result.ok) {
      return c.json({ error: result.error }, result.error === "Chat not found" ? 404 : 500);
    }

    return c.json({ success: true }, 200);
  });

export default chatRoutes;
export type ChatRoutes = typeof chatRoutes;

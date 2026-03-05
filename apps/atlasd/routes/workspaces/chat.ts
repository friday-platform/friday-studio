/**
 * Workspace chat routes.
 *
 * POST /                 — Create chat, stream response via SSE
 * GET  /                 — List workspace chats
 * GET  /:chatId          — Get workspace chat
 * GET  /:chatId/stream   — Resume SSE stream
 * DELETE /:chatId/stream — Stop stream (cosmetic)
 */

import process from "node:process";
import { validateAtlasUIMessages } from "@atlas/agent-sdk";
import { createAnalyticsClient, EventNames } from "@atlas/analytics";
import { ChatStorage } from "@atlas/core/chat/storage";
import { extractTempestUserId } from "@atlas/core/credentials";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { zValidator } from "@hono/zod-validator";
import { stream } from "hono/streaming";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";
import { isClientSafeEvent } from "../../src/stream-event-filter.ts";

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

const workspaceChatRoutes = daemonFactory
  .createApp()
  /**
   * Middleware: validate workspace exists for all chat routes.
   * Runs before every handler — returns 404 for unknown workspaceIds.
   */
  .use("*", async (c, next) => {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) {
      return c.json({ error: "Missing workspaceId" }, 400);
    }
    const ctx = c.get("app");
    const manager = ctx.getWorkspaceManager();
    const workspace = await manager.find({ id: workspaceId });
    if (!workspace) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    await next();
  })
  /**
   * GET /
   * List chats for this workspace.
   */
  .get("/", zValidator("query", listChatsQuerySchema), async (c) => {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) {
      return c.json({ error: "Missing workspaceId" }, 400);
    }

    const { limit, cursor } = c.req.valid("query");
    const result = await ChatStorage.listChatsByWorkspace(workspaceId, { limit, cursor });
    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }

    return c.json(result.data, 200);
  })

  /**
   * POST /
   * Create chat, store message, trigger "chat" signal, stream events.
   */
  .post("/", zValidator("json", chatRequestSchema), async (c) => {
    const ctx = c.get("app");
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) {
      return c.json({ error: "Missing workspaceId" }, 400);
    }

    const { id: chatId, message, datetime } = c.req.valid("json");
    const userId = getUserId();

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

    const [userMessage] = await validateAtlasUIMessages([message]);
    if (!userMessage) {
      return c.json({ error: "Invalid message format" }, 400);
    }

    const appendResult = await ChatStorage.appendMessage(chatId, userMessage, workspaceId);
    if (!appendResult.ok) {
      return c.json({ error: "Failed to store message" }, 500);
    }

    const runtime = await ctx.getOrCreateWorkspaceRuntime(workspaceId).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("Workspace not found")) {
        return null;
      }
      throw error;
    });

    if (!runtime) {
      return c.json({ error: "Workspace not found" }, 404);
    }

    // Initialize stream buffer for resumption support
    ctx.streamRegistry.createStream(chatId);

    // Stream response directly with SSE format
    return stream(c, async (streamWriter) => {
      let sessionComplete = false;

      runtime
        .triggerSignalWithSession(
          "chat",
          { chatId, userId, streamId: chatId, datetime },
          chatId,
          async (chunk) => {
            if (chunk.type === "data-session-finish") {
              sessionComplete = true;
            }

            // Only forward UI message stream events to the client.
            // FSM lifecycle events (data-fsm-*, data-session-*) break the
            // AI SDK's client-side parser which validates against uiMessageChunkSchema.
            if (!isClientSafeEvent(chunk)) return;

            // Buffer event for potential resumption
            ctx.streamRegistry.appendEvent(chatId, chunk);

            // Write to this HTTP connection
            try {
              await streamWriter.write(`data: ${JSON.stringify(chunk)}\n\n`);
            } catch (error) {
              // Client disconnected - events continue buffering in registry
              logger.debug("Client disconnected during workspace chat stream", {
                chatId,
                workspaceId,
                error,
              });
            }
          },
        )
        .catch((error) => {
          logger.error("Workspace chat session error", { error, chatId, workspaceId });
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
   * DELETE /:chatId/stream
   * Mark a stream as finished (cosmetic stop).
   */
  .delete("/:chatId/stream", (c) => {
    const ctx = c.get("app");
    const chatId = c.req.param("chatId");

    ctx.streamRegistry.finishStream(chatId);

    return c.json({ success: true }, 200);
  })

  /**
   * GET /:chatId/stream
   * Reconnect to an active chat stream for resumption.
   */
  .get("/:chatId/stream", (c) => {
    const ctx = c.get("app");
    const chatId = c.req.param("chatId");

    const buffer = ctx.streamRegistry.getStream(chatId);

    if (!buffer || !buffer.active) {
      return c.body(null, 204);
    }

    c.header("X-Turn-Started-At", String(buffer.createdAt));

    const readableStream = new ReadableStream<Uint8Array>({
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

    return c.body(readableStream, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
  })

  /**
   * GET /:chatId
   * Retrieve chat metadata and message history.
   */
  .get("/:chatId", async (c) => {
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId");

    const chatResult = await ChatStorage.getChat(chatId, workspaceId);
    if (!chatResult.ok || !chatResult.data) {
      return c.json({ error: "Chat not found" }, 404);
    }

    const { messages, systemPromptContext, ...chat } = chatResult.data;
    const limitedMessages = messages.slice(-100);

    return c.json(
      { chat, messages: limitedMessages, systemPromptContext: systemPromptContext ?? null },
      200,
    );
  })

  /**
   * POST /:chatId/message
   * Append assistant message to chat history.
   */
  .post("/:chatId/message", zValidator("json", z.object({ message: z.unknown() })), async (c) => {
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId");
    const { message } = c.req.valid("json");

    const chatResult = await ChatStorage.getChat(chatId, workspaceId);
    if (!chatResult.ok || !chatResult.data) {
      return c.json({ error: "Chat not found" }, 404);
    }

    const [validatedMessage] = await validateAtlasUIMessages([message]);
    if (!validatedMessage) {
      return c.json({ error: "Invalid message format" }, 400);
    }

    const appendResult = await ChatStorage.appendMessage(chatId, validatedMessage, workspaceId);
    if (!appendResult.ok) {
      logger.error("Failed to append assistant message", { chatId, error: appendResult.error });
      return c.json({ error: "Failed to append message" }, 500);
    }

    return c.json({ success: true }, 200);
  })

  /**
   * PATCH /:chatId/title
   * Update chat title.
   */
  .patch("/:chatId/title", zValidator("json", z.object({ title: z.string() })), async (c) => {
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId");
    const { title } = c.req.valid("json");

    const result = await ChatStorage.updateChatTitle(chatId, title, workspaceId);
    if (!result.ok) {
      return c.json({ error: result.error }, result.error === "Chat not found" ? 404 : 500);
    }

    return c.json({ chat: result.data }, 200);
  });

export default workspaceChatRoutes;
export type WorkspaceChatRoutes = typeof workspaceChatRoutes;

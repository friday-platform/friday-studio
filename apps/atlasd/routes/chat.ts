import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { validateAtlasUIMessages } from "@atlas/agent-sdk";
import { ChatStorage } from "@atlas/core/chat/storage";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { zValidator } from "@hono/zod-validator";
import { stream } from "hono/streaming";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";

const chatRequestSchema = z.object({ id: z.uuid(), message: z.unknown() });
const appendMessageSchema = z.object({ message: z.unknown() });
const updateTitleSchema = z.object({ title: z.string() });
const listChatsQuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).optional(),
  cursor: z.coerce.number().optional(),
});

/**
 * Extract text content from user message.
 * TEMPORARY: Signal handler should accept full AtlasUIMessage, not just text.
 * This extraction belongs in the conversation agent, not the transport layer.
 */
function extractTextContent(message: AtlasUIMessage): string {
  if (!message.parts) throw new Error("Message has no parts");

  const textParts = message.parts
    .filter((part) => part.type === "text")
    .map((part) => ("text" in part ? part.text : ""))
    .join("\n");

  if (!textParts.trim()) throw new Error("Message has no text content");
  return textParts;
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
    const { id: chatId, message } = c.req.valid("json");
    const userId = c.req.header("X-User-Id") || "default-user";
    const workspaceId = c.req.header("X-Workspace-Id") || "atlas-conversation";

    const result = await ChatStorage.createChat({ chatId, userId, workspaceId });
    if (!result.ok) {
      return c.json({ error: "Failed to create chat" }, 500);
    }

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

    // TEMPORARY: Extract text for signal handler. Remove when handler accepts full message.
    const textContent = extractTextContent(userMessage);

    // Stream response directly with SSE format
    return stream(c, async (streamWriter) => {
      let sessionComplete = false;

      runtime
        .triggerSignalWithSession(
          "conversation-stream",
          { chatId, message: textContent, userId },
          chatId,
          async (event) => {
            try {
              await streamWriter.write(`data: ${JSON.stringify(event)}\n\n`);
              if (event.type === "data-session-finish") {
                sessionComplete = true;
              }
            } catch (error) {
              logger.error("Error writing event to stream", { error, chatId });
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
   * GET /api/chat/:chatId
   * Retrieve chat metadata and message history.
   */
  .get("/:chatId", async (c) => {
    const chatId = c.req.param("chatId");

    const chatResult = await ChatStorage.getChat(chatId);
    if (!chatResult.ok || !chatResult.data) {
      return c.json({ error: "Chat not found" }, 404);
    }

    const { messages, ...chat } = chatResult.data;
    // Return last 100 messages in chronological order (oldest first)
    const limitedMessages = messages.slice(-100);

    return c.json({ chat, messages: limitedMessages }, 200);
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

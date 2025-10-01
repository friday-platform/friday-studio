import { conversationStorage, type SessionUIMessage } from "@atlas/core";
import { stringifyError } from "@atlas/utils";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";

/**
 * TODO: Use z.array(UIMessageSchema) once AI SDK exports it.
 */
const TEMP_UI_MESSAGE_SCHEMA = z.unknown();

/**
 * Chat storage API routes for Atlas daemon (RPC version).
 *
 * Provides HTTP endpoints for managing conversation state across sessions.
 * Each streamId maps to a conversation history used by SessionSupervisor
 * for context persistence between signal processing cycles.
 */
const chatStorageRoutes = daemonFactory
  .createApp()
  // GET / - List conversations
  .get("/", (c) => {
    try {
      const conversations = conversationStorage.list();
      return c.json({ conversations, conversationCount: conversations.length }, 200);
    } catch (error) {
      return c.json({ error: stringifyError(error) }, 500);
    }
  })
  // GET /:streamId - Retrieve conversation history for SessionSupervisor
  .get("/:streamId", zValidator("param", z.object({ streamId: z.string() })), (c) => {
    try {
      const { streamId } = c.req.valid("param");
      const messages = conversationStorage.get(streamId);
      return c.json({ messages, messageCount: messages.length }, 200);
    } catch (error) {
      return c.json({ error: stringifyError(error) }, 500);
    }
  })
  // PUT /:streamId - Update conversation state with new message history
  .put(
    "/:streamId",
    zValidator("param", z.object({ streamId: z.string() })),
    zValidator("json", z.object({ messages: z.array(TEMP_UI_MESSAGE_SCHEMA) })),
    (c) => {
      try {
        const { streamId } = c.req.valid("param");
        const data = c.req.valid("json");

        // @ts-expect-error AI SDK doesn't export Zod schemas for UIMessage/UIMessageChunk
        // so we accept z.array(z.unknown()) and cast to AtlasUIMessage[]
        // @see: https://github.com/vercel/ai/issues/8100
        const messages: SessionUIMessage[] = data.messages;

        conversationStorage.replace(streamId, messages);
        return c.json({ messages }, 200);
      } catch (error) {
        return c.json({ error: stringifyError(error) }, 500);
      }
    },
  );

export { chatStorageRoutes };
export type ChatStorageRoutes = typeof chatStorageRoutes;

import { describeRoute, resolver, validator } from "hono-openapi";
import { daemonFactory } from "../../src/factory.ts";
import {
  errorResponseSchema,
  storeDataSchema,
  storeResponseSchema,
  streamIdParamSchema,
} from "./schemas.ts";

const createMessage = daemonFactory.createApp();

createMessage.post(
  "/",
  describeRoute({
    tags: ["Conversation Storage"],
    summary: "Store conversation message",
    description: "Store a message in the conversation history for the given stream ID",
    responses: {
      200: {
        description: "Message stored successfully",
        content: { "application/json": { schema: resolver(storeResponseSchema) } },
      },
      400: {
        description: "Invalid request data",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("param", streamIdParamSchema),
  validator("json", storeDataSchema),
  async (c) => {
    try {
      const { streamId } = c.req.valid("param");
      const data = c.req.valid("json");

      // Access the conversation storage directly
      const { InMemoryConversationStorage } = await import(
        "../../../../src/core/daemon-capabilities.ts"
      );
      const storage = InMemoryConversationStorage.getInstance();

      // Create a conversation message object
      const messageObj = {
        messageId: crypto.randomUUID(),
        userId: undefined,
        content: data.message.content,
        timestamp: data.timestamp,
        role: data.message.role,
        metadata: { streamId, ...data.metadata },
      };

      // Save the message
      storage.saveMessage(streamId, messageObj);

      return c.json({ success: true, messageId: messageObj.messageId });
    } catch (error) {
      return c.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

export { createMessage };

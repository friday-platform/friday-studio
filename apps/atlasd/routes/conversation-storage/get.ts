import { daemonFactory } from "../../src/factory.ts";
import { describeRoute, resolver, validator } from "hono-openapi";
import { conversationHistorySchema, errorResponseSchema, streamIdParamSchema } from "./schemas.ts";

const getConversation = daemonFactory.createApp();

getConversation.get(
  "/",
  describeRoute({
    tags: ["Conversation Storage"],
    summary: "Retrieve conversation history",
    description: "Get the complete conversation history for the given stream ID",
    responses: {
      200: {
        description: "Conversation history retrieved successfully",
        content: {
          "application/json": {
            schema: resolver(conversationHistorySchema),
          },
        },
      },
      404: {
        description: "Conversation not found",
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
  validator("param", streamIdParamSchema),
  async (c) => {
    try {
      const { streamId } = c.req.valid("param");

      // Note: App context available at c.get("app") if needed

      // Access the conversation storage directly
      const { InMemoryConversationStorage } = await import(
        "../../../../src/core/daemon-capabilities.ts"
      );
      const storage = InMemoryConversationStorage.getInstance();

      // Get conversation history
      const history = storage.getConversationHistory(streamId);
      const messages = history?.messages || [];

      return c.json({
        success: true,
        messages,
        messageCount: messages.length,
      });
    } catch (error) {
      return c.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

export { getConversation };

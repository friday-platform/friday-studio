import { describeRoute, resolver, validator } from "hono-openapi";
import { daemonFactory } from "../../src/factory.ts";
import { deleteResponseSchema, errorResponseSchema, streamIdParamSchema } from "./schemas.ts";

const deleteConversation = daemonFactory.createApp();

deleteConversation.delete(
  "/",
  describeRoute({
    tags: ["Conversation Storage"],
    summary: "Delete conversation",
    description: "Delete all conversation history for the given stream ID",
    responses: {
      200: {
        description: "Conversation deleted successfully",
        content: { "application/json": { schema: resolver(deleteResponseSchema) } },
      },
      404: {
        description: "Conversation not found",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
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

      // Check if conversation exists
      const history = storage.getConversationHistory(streamId);
      const existed = history && history.messages.length > 0;

      // Delete conversation using the public API
      storage.deleteConversation(streamId);

      return c.json({ success: true, deleted: existed });
    } catch (error) {
      return c.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

export { deleteConversation };

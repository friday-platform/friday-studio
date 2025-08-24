import { describeRoute, resolver, validator } from "hono-openapi";
import { daemonFactory } from "../../src/factory.ts";
import { conversationListSchema, errorResponseSchema, listParamsSchema } from "./schemas.ts";

const listConversations = daemonFactory.createApp();

listConversations.get(
  "/",
  describeRoute({
    tags: ["Conversation Storage"],
    summary: "List conversations",
    description: "Get a list of all conversations with summary information",
    responses: {
      200: {
        description: "Conversation list retrieved successfully",
        content: { "application/json": { schema: resolver(conversationListSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("query", listParamsSchema),
  async (c) => {
    try {
      const { limit, offset } = c.req.valid("query");

      // Note: App context available at c.get("app") if needed

      // Access the conversation storage directly
      const { InMemoryConversationStorage } = await import(
        "../../../../src/core/daemon-capabilities.ts"
      );
      const storage = InMemoryConversationStorage.getInstance();

      // Get all conversations using the public API
      const conversationList = storage
        .listConversations()
        .map((conv) => ({
          streamId: conv.streamId,
          messageCount: conv.messageCount,
          lastMessage: conv.lastMessage
            ? conv.lastMessage.content.substring(0, 100) +
              (conv.lastMessage.content.length > 100 ? "..." : "")
            : "",
          lastTimestamp: conv.lastMessage?.timestamp || "",
        }))
        .filter((conv) => conv.messageCount > 0);

      // Apply pagination
      const startIdx = offset || 0;
      const endIdx = limit ? startIdx + limit : undefined;
      const paginatedList = conversationList.slice(startIdx, endIdx);

      return c.json({
        success: true,
        conversations: paginatedList,
        total: conversationList.length,
      });
    } catch (error) {
      return c.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

export { listConversations };

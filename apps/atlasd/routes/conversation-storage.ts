import { z } from "zod/v4";
import { daemonFactory } from "../src/factory.ts";
import { describeRoute } from "hono-openapi";
import { resolver, validator } from "hono-openapi/zod";

// Create app instance using factory
const conversationStorageRoutes = daemonFactory.createApp();

// ============================================================================
// Zod Schemas
// ============================================================================

// Input schemas
const storeDataSchema = z.object({
  message: z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  }),
  metadata: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.string(),
}).meta({ description: "Conversation message data to store" });

const listParamsSchema = z.object({
  limit: z.coerce.number().optional().describe("Maximum number of conversations to return"),
  offset: z.coerce.number().optional().describe("Number of conversations to skip"),
}).meta({ description: "Pagination parameters for conversation list" });

const streamIdParamSchema = z.object({
  streamId: z.string().min(1).describe("Stream ID for conversation operations"),
}).meta({ description: "Stream ID parameter" });

// Response schemas
const conversationMessageSchema = z.object({
  messageId: z.string(),
  userId: z.string().optional(),
  content: z.string(),
  timestamp: z.string(),
  role: z.enum(["user", "assistant"]),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).meta({ description: "Conversation message" });

const conversationHistorySchema = z.object({
  success: z.boolean(),
  messages: z.array(conversationMessageSchema),
  messageCount: z.number(),
}).meta({ description: "Conversation history response" });

const storeResponseSchema = z.object({
  success: z.boolean(),
  messageId: z.string().optional(),
  error: z.string().optional(),
}).meta({ description: "Store message response" });

const conversationListSchema = z.object({
  success: z.boolean(),
  conversations: z.array(z.object({
    streamId: z.string(),
    messageCount: z.number(),
    lastMessage: z.string(),
    lastTimestamp: z.string(),
  })),
  total: z.number(),
}).meta({ description: "Conversation list response" });

const deleteResponseSchema = z.object({
  success: z.boolean(),
  deleted: z.boolean().optional(),
  error: z.string().optional(),
}).meta({ description: "Delete conversation response" });

const errorResponseSchema = z.object({
  error: z.string(),
}).meta({ description: "Standard error response" });

// ============================================================================
// Route Handlers
// ============================================================================

// Store conversation data
conversationStorageRoutes.post(
  "/api/conversation-storage/:streamId",
  describeRoute({
    tags: ["Conversation Storage"],
    summary: "Store conversation message",
    description: "Store a message in the conversation history for the given stream ID",
    responses: {
      200: {
        description: "Message stored successfully",
        content: {
          "application/json": {
            schema: resolver(storeResponseSchema),
          },
        },
      },
      400: {
        description: "Invalid request data",
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
  validator("json", storeDataSchema),
  async (c) => {
    try {
      const { streamId } = c.req.valid("param");
      const data = c.req.valid("json");

      // Get the app context (daemon context would need to be added to AppContext)
      const _ctx = c.get("app");

      // Access the conversation storage directly
      const { InMemoryConversationStorage } = await import(
        "../../../src/core/daemon-capabilities.ts"
      );
      const storage = InMemoryConversationStorage.getInstance();

      // Create a conversation message object
      const messageObj = {
        messageId: crypto.randomUUID(),
        userId: undefined,
        content: data.message.content,
        timestamp: data.timestamp,
        role: data.message.role,
        metadata: {
          streamId,
          ...data.metadata,
        },
      };

      // Save the message
      storage.saveMessage(streamId, messageObj);

      return c.json({
        success: true,
        messageId: messageObj.messageId,
      });
    } catch (error) {
      return c.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

// Retrieve conversation history
conversationStorageRoutes.get(
  "/api/conversation-storage/:streamId",
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

      // Get the app context (daemon context would need to be added to AppContext)
      const _ctx = c.get("app");

      // Access the conversation storage directly
      const { InMemoryConversationStorage } = await import(
        "../../../src/core/daemon-capabilities.ts"
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

// List conversations
conversationStorageRoutes.get(
  "/api/conversation-storage",
  describeRoute({
    tags: ["Conversation Storage"],
    summary: "List conversations",
    description: "Get a list of all conversations with summary information",
    responses: {
      200: {
        description: "Conversation list retrieved successfully",
        content: {
          "application/json": {
            schema: resolver(conversationListSchema),
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
  validator("query", listParamsSchema),
  async (c) => {
    try {
      const { limit, offset } = c.req.valid("query");

      // Get the app context (daemon context would need to be added to AppContext)
      const _ctx = c.get("app");

      // Access the conversation storage directly
      const { InMemoryConversationStorage } = await import(
        "../../../src/core/daemon-capabilities.ts"
      );
      const storage = InMemoryConversationStorage.getInstance();

      // Get all conversations using the public API
      const conversationList = storage.listConversations().map((conv) => ({
        streamId: conv.streamId,
        messageCount: conv.messageCount,
        lastMessage: conv.lastMessage
          ? conv.lastMessage.content.substring(0, 100) +
            (conv.lastMessage.content.length > 100 ? "..." : "")
          : "",
        lastTimestamp: conv.lastMessage?.timestamp || "",
      })).filter((conv) => conv.messageCount > 0);

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

// Delete conversation
conversationStorageRoutes.delete(
  "/api/conversation-storage/:streamId",
  describeRoute({
    tags: ["Conversation Storage"],
    summary: "Delete conversation",
    description: "Delete all conversation history for the given stream ID",
    responses: {
      200: {
        description: "Conversation deleted successfully",
        content: {
          "application/json": {
            schema: resolver(deleteResponseSchema),
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

      // Get the app context (daemon context would need to be added to AppContext)
      const _ctx = c.get("app");

      // Access the conversation storage directly
      const { InMemoryConversationStorage } = await import(
        "../../../src/core/daemon-capabilities.ts"
      );
      const storage = InMemoryConversationStorage.getInstance();

      // Check if conversation exists
      const history = storage.getConversationHistory(streamId);
      const existed = history && history.messages.length > 0;

      // Delete conversation using the public API
      const _deleted = storage.deleteConversation(streamId);

      return c.json({
        success: true,
        deleted: existed,
      });
    } catch (error) {
      return c.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

export { conversationStorageRoutes };

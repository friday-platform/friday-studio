import { z } from "zod/v4";

// ============================================================================
// Shared Parameter Schemas
// ============================================================================

export const streamIdParamSchema = z.object({
  streamId: z.string().min(1).describe("Stream ID for conversation operations"),
}).meta({ description: "Stream ID parameter" });

export const listParamsSchema = z.object({
  limit: z.coerce.number().optional().describe("Maximum number of conversations to return"),
  offset: z.coerce.number().optional().describe("Number of conversations to skip"),
}).meta({ description: "Pagination parameters for conversation list" });

// ============================================================================
// Input Schemas
// ============================================================================

export const storeDataSchema = z.object({
  message: z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string(),
  }),
  metadata: z.record(z.string(), z.unknown()).optional(),
  timestamp: z.string(),
}).meta({ description: "Conversation message data to store" });

// ============================================================================
// Response Schemas
// ============================================================================

export const conversationMessageSchema = z.object({
  messageId: z.string(),
  userId: z.string().optional(),
  content: z.string(),
  timestamp: z.string(),
  role: z.enum(["user", "assistant"]),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).meta({ description: "Conversation message" });

export const conversationHistorySchema = z.object({
  success: z.boolean(),
  messages: z.array(conversationMessageSchema),
  messageCount: z.number(),
}).meta({ description: "Conversation history response" });

export const storeResponseSchema = z.object({
  success: z.boolean(),
  messageId: z.string().optional(),
  error: z.string().optional(),
}).meta({ description: "Store message response" });

export const conversationListSchema = z.object({
  success: z.boolean(),
  conversations: z.array(z.object({
    streamId: z.string(),
    messageCount: z.number(),
    lastMessage: z.string(),
    lastTimestamp: z.string(),
  })),
  total: z.number(),
}).meta({ description: "Conversation list response" });

export const deleteResponseSchema = z.object({
  success: z.boolean(),
  deleted: z.boolean().optional(),
  error: z.string().optional(),
}).meta({ description: "Delete conversation response" });

export const errorResponseSchema = z.object({
  error: z.string(),
}).meta({ description: "Standard error response" });

// ============================================================================
// Type Exports
// ============================================================================

export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type ConversationHistory = z.infer<typeof conversationHistorySchema>;
export type StoreResponse = z.infer<typeof storeResponseSchema>;
export type ConversationList = z.infer<typeof conversationListSchema>;
export type DeleteResponse = z.infer<typeof deleteResponseSchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

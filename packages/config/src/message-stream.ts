/**
 * SSE Event Schemas for Message Streaming
 *
 * These schemas define the structure of Server-Sent Events (SSE)
 * used for streaming conversation messages between the daemon and CLI.
 */

import { z } from "zod/v4";

// Request event - represents a user's request/input
export const RequestEventSchema = z.object({
  id: z.string(),
  type: z.literal("request"),
  data: z.object({ content: z.string() }),
  timestamp: z.string(),
});

// Message event - represents text content from the assistant
export const MessageEventSchema = z.object({
  id: z.string(),
  type: z.literal("text"),
  data: z.object({ content: z.string() }),
  timestamp: z.string(),
});

// Finish event - indicates completion of a response
export const FinishEventSchema = z.object({
  id: z.string(),
  type: z.literal("finish"),
  data: z.object({ content: z.string() }),
  timestamp: z.string(),
});

// Error event - represents an error that occurred
export const ErrorEventSchema = z.object({
  id: z.string(),
  type: z.literal("error"),
  data: z.object({ content: z.string() }),
  timestamp: z.string(),
});

// Tool call event - represents a tool being invoked
export const ToolCallEventSchema = z.object({
  id: z.string(),
  type: z.literal("tool_call"),
  data: z.object({
    content: z.string(),
    toolName: z.string(),
    args: z.record(z.string(), z.unknown()).optional(),
    toolCallId: z.string().optional(),
  }),
  timestamp: z.string(),
});

// Tool result event - represents the result of a tool call
export const ToolResultEventSchema = z.object({
  id: z.string(),
  type: z.literal("tool_result"),
  data: z.object({
    content: z.string(),
    toolName: z.string(),
    result: z.unknown(),
    toolCallId: z.string().optional(),
  }),
  timestamp: z.string(),
});

// Thinking event - represents the assistant's internal reasoning
export const ThinkingEventSchema = z.object({
  id: z.string(),
  type: z.literal("thinking"),
  data: z.object({ content: z.string() }),
  timestamp: z.string(),
});

// Union of all SSE event types
export const SSEEventSchema = z.union([
  RequestEventSchema,
  FinishEventSchema,
  MessageEventSchema,
  ErrorEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  ThinkingEventSchema,
]);

// Type exports for easier use
export type RequestEvent = z.infer<typeof RequestEventSchema>;
export type MessageEvent = z.infer<typeof MessageEventSchema>;
export type FinishEvent = z.infer<typeof FinishEventSchema>;
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;
export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;
export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>;
export type ThinkingEvent = z.infer<typeof ThinkingEventSchema>;
export type SSEEvent = z.infer<typeof SSEEventSchema>;

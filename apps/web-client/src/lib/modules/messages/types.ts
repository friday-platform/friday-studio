import { z } from "zod/v4";

// const ConnectionOpenEventSchema = z.object({
// 	type: z.literal('connection_opened'),
// 	data: z.object({
// 		sessionId: z.string(),
// 		timestamp: z.string()
// 	})
// });

// const HeartbeatEventSchema = z.object({
// 	type: z.literal('heartbeat'),
// 	data: z.object({
// 		timestamp: z.string()
// 	})
// });

const RequestEventSchema = z.object({
  id: z.string(),
  type: z.literal("request"),
  data: z.object({ content: z.string() }),
  timestamp: z.string(),
});

const MessageEventSchema = z.object({
  id: z.string(),
  type: z.literal("text"),
  data: z.object({ content: z.string() }),
  timestamp: z.string(),
});

const FinishEventSchema = z.object({
  id: z.string(),
  type: z.literal("finish"),
  data: z.object({ content: z.string() }),
  timestamp: z.string(),
});

const ErrorEventSchema = z.object({
  id: z.string(),
  type: z.literal("error"),
  data: z.object({ content: z.string() }),
  timestamp: z.string(),
});

const ToolCallEventSchema = z.object({
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

const ToolResultEventSchema = z.object({
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

const ThinkingEventSchema = z.object({
  id: z.string(),
  type: z.literal("thinking"),
  data: z.object({ content: z.string() }),
  timestamp: z.string(),
});

const SSEEventSchema = z.union([
  RequestEventSchema,
  MessageEventSchema,
  FinishEventSchema,
  ErrorEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  ThinkingEventSchema,
]);

export interface OutputEntry {
  id: string;
  type:
    | "text" // response
    | "thinking"
    | "request"
    | "finish"
    | "tool_call"
    | "tool_result"
    | "error"
    | "header"
    | "typing";
  author?: string;
  timestamp?: string;
  content?: string;
  currentlyStreaming?: boolean;
  metadata?: Record<string, unknown>;
}

import { NotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Local copy of StreamEventSchema to avoid zod/v4 conflicts
export const StreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    content: z.string(),
  }),
  z.object({
    type: z.literal("tool-call"),
    toolName: z.string(),
    args: z.unknown(),
  }),
  z.object({
    type: z.literal("tool-result"),
    toolName: z.string(),
    result: z.unknown(),
  }),
  z.object({
    type: z.literal("thinking"),
    content: z.string(),
  }),
  z.object({
    type: z.literal("error"),
    error: z.union([z.instanceof(Error), z.string()]),
  }),
  z.object({
    type: z.literal("finish"),
    reason: z.string().optional(),
  }),
  z.object({
    type: z.literal("usage"),
    tokens: z.object({
      input: z.number().optional(),
      cachedInput: z.number().optional(),
      output: z.number().optional(),
      total: z.number().optional(),
    }),
  }),
  z.object({
    type: z.literal("progress"),
    message: z.string(),
    percentage: z.number().optional(),
  }),
  z.object({
    type: z.literal("custom"),
    eventType: z.string(),
    data: z.unknown(),
  }),
]);

export type StreamEvent = z.infer<typeof StreamEventSchema>;

export const StreamContentNotificationSchema = NotificationSchema.extend({
  method: z.literal("notifications/tool/streamContent"),
  params: z.object({
    toolName: z.string(),
    sessionId: z.string(),
    events: z.array(StreamEventSchema),
  }),
});

export type StreamContentNotification = z.infer<typeof StreamContentNotificationSchema>;

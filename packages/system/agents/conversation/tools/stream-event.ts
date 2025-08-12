/**
 * Stream Event Tool - SDK Architecture
 * Adapted from packages/tools/src/internal/conversation.ts
 *
 * Sends rich events to the conversation stream for real-time UI updates
 */

import { tool } from "ai";
import { z } from "zod/v4";
import { getAtlasDaemonUrl } from "@atlas/atlasd";
import { fetchWithTimeout, handleDaemonResponse } from "./utils.ts";

export const streamEvent = tool({
  description: "Stream rich events (thinking, tool calls, messages) to the conversation UI",
  inputSchema: z.object({
    id: z.string().describe("Unique identifier"),
    streamId: z.string().describe("Stream identifier"),
    eventType: z
      .enum(["thinking", "text", "request", "tool_call", "tool_result", "error", "finish"])
      .describe("Type of event being streamed"),
    content: z.string().describe("Primary content of the event"),
    timestamp: z.string().describe("Timestamp of the event"),
    metadata: z
      .object({
        toolName: z.string().optional(),
        toolCallId: z.string().optional(),
        args: z.record(z.string(), z.unknown()).optional(),
        result: z.unknown().optional(),
        error: z.string().optional(),
      })
      .optional()
      .describe("Event-specific metadata"),
  }),
  execute: async ({ id, streamId, eventType, content, timestamp, metadata }) => {
    try {
      // Direct event type usage (no mapping)
      const event = {
        id,
        type: eventType,
        data: { content, ...metadata },
        timestamp,
        sessionId: streamId,
      };

      const url = `${getAtlasDaemonUrl()}/api/stream/${streamId}/emit`;

      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      });

      const result = await handleDaemonResponse(response);
      return { success: true, streamId, eventType, result };
    } catch {
      throw new Error("Failed to stream event");
    }
  },
});

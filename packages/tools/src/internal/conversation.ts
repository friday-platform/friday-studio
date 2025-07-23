/**
 * Conversation tools for Atlas
 * Handles streaming replies and conversation history management
 */

import { z } from "zod/v4";
import { tool } from "ai";
import {
  defaultContext,
  fetchWithTimeout,
  getErrorMessage,
  handleDaemonResponse,
} from "../utils.ts";

/**
 * Stream reply tool - Send a streaming reply to a stream via SSE
 * Note: This is the base implementation that requires streamId parameter.
 * @deprecated Use atlas_stream_event instead.
 */
export const atlas_stream_reply = tool({
  description:
    "Send a streaming reply to a stream via Server-Sent Events (SSE). Emits messages to connected SSE clients for real-time communication in conversations.",
  inputSchema: z.object({
    streamId: z.string().describe("The unique identifier of the stream to send the reply to"),
    content: z.string().describe("The content to send as a streaming reply"),
    metadata: z.record(z.string(), z.unknown()).optional().describe(
      "Optional metadata to include with the reply",
    ),
  }),
  execute: async ({ streamId, content, metadata }) => {
    try {
      const response = await fetchWithTimeout(
        `${defaultContext.daemonUrl}/api/stream/${streamId}/emit`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          // Send the event in the format expected by the UI
          // The daemon will wrap this in SSE format: data: {...}
          body: JSON.stringify({
            type: "message_chunk",
            data: {
              content,
              partial: false,
            },
            timestamp: new Date().toISOString(),
            sessionId: streamId,
          }),
        },
      );

      const result = await handleDaemonResponse(response);
      return {
        success: true,
        streamId,
        content,
        metadata,
        result,
      };
    } catch (error) {
      throw new Error(`Failed to send streaming reply: ${getErrorMessage(error)}`);
    }
  },
});

/**
 * Stream event tool - Stream rich events (thinking, tool calls, messages) to the conversation UI
 */
export const atlas_stream_event = tool({
  description: "Stream rich events (thinking, tool calls, messages) to the conversation UI",
  inputSchema: z.object({
    streamId: z.string().describe("Stream identifier"),
    eventType: z
      .enum(["thinking", "message", "tool_call", "tool_result", "error"])
      .describe("Type of event being streamed"),
    content: z.string().describe("Primary content of the event"),
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
  execute: async ({ streamId, eventType, content, metadata }) => {
    try {
      // Direct event type usage (no mapping)
      const event = {
        type: eventType,
        data: {
          content,
          ...metadata,
        },
        timestamp: new Date().toISOString(),
        sessionId: streamId,
      };

      const url = `${defaultContext.daemonUrl}/api/stream/${streamId}/emit`;
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(event),
      });

      const result = await handleDaemonResponse(response);

      return {
        success: true,
        streamId,
        eventType,
        result,
      };
    } catch (error) {
      throw new Error(`Failed to stream event: ${getErrorMessage(error)}`);
    }
  },
});

/**
 * Conversation storage tool - Manage conversation history using stream_id as key
 */
export const atlas_conversation_storage = tool({
  description:
    "Manage conversation history using stream_id as key. Supports storing, retrieving, listing, and deleting conversation data.",
  inputSchema: z.object({
    operation: z.enum(["store", "retrieve", "list", "delete"]).describe(
      "The operation to perform on conversation storage",
    ),
    streamId: z.string().optional().describe(
      "The stream ID to operate on (required for store, retrieve, delete operations)",
    ),
    data: z.record(z.string(), z.unknown()).optional().describe(
      "The data to store (required for store operation)",
    ),
    limit: z.number().optional().describe("Maximum number of items to return (for list operation)"),
    offset: z.number().optional().describe("Number of items to skip (for list operation)"),
  }).refine((data) => {
    // Validate required fields based on operation
    if (data.operation === "store") {
      return data.streamId && data.data;
    }
    if (data.operation === "retrieve" || data.operation === "delete") {
      return data.streamId;
    }
    // list operation doesn't require streamId
    return true;
  }, {
    message:
      "streamId is required for store, retrieve, and delete operations; data is required for store operation",
  }),
  execute: async ({ operation, streamId, data, limit, offset }) => {
    try {
      let url = `${defaultContext.daemonUrl}/api/conversation-storage`;
      let method = "GET";
      let body: string | undefined;

      switch (operation) {
        case "store":
          url = `${defaultContext.daemonUrl}/api/conversation-storage/${streamId}`;
          method = "POST";
          body = JSON.stringify(data);
          break;
        case "retrieve":
          url = `${defaultContext.daemonUrl}/api/conversation-storage/${streamId}`;
          method = "GET";
          break;
        case "list": {
          const params = new URLSearchParams();
          if (limit) params.append("limit", limit.toString());
          if (offset) params.append("offset", offset.toString());
          url = `${defaultContext.daemonUrl}/api/conversation-storage?${params}`;
          method = "GET";
          break;
        }
        case "delete":
          url = `${defaultContext.daemonUrl}/api/conversation-storage/${streamId}`;
          method = "DELETE";
          break;
      }

      const response = await fetchWithTimeout(url, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body,
      });

      const result = await handleDaemonResponse(response);
      return {
        success: true,
        operation,
        streamId,
        result,
      };
    } catch (error) {
      throw new Error(`Failed to manage conversation storage: ${getErrorMessage(error)}`);
    }
  },
});

/**
 * Export all conversation tools
 */
export const conversationTools = {
  atlas_stream_reply,
  atlas_stream_event,
  atlas_conversation_storage,
};

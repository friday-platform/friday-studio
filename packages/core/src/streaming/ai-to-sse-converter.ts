/**
 * AI SDK to SSE Event Converter
 *
 * Converts streams from the AI SDK (used by conversation agent)
 * to the SSE event format expected by the message buffer in the CLI.
 */

import type { TextStreamPart, ToolSet } from "ai";
import type {
  ErrorEvent,
  FinishEvent,
  MessageEvent,
  RequestEvent,
  SSEEvent,
  ThinkingEvent,
  ToolCallEvent,
} from "@atlas/config";

// Track unique IDs for streaming events that share the same ID
let currentStreamId: string | undefined;

function getUniqueId(type: string, prevType?: string): string {
  // For continuous text or thinking chunks, maintain the same ID
  if (type === prevType && currentStreamId) {
    return currentStreamId;
  }
  currentStreamId = crypto.randomUUID();
  return currentStreamId;
}

/**
 * Convert an AI SDK stream chunk to an SSE event format.
 * This maintains compatibility with the message buffer UI component.
 *
 * @param chunk - The current stream chunk from AI SDK
 * @param prevChunk - The previous chunk (for ID continuity)
 * @returns SSE event or null if the chunk should be skipped
 */
export function convertAIStreamToSSE(
  chunk: TextStreamPart<ToolSet>,
  prevChunk?: TextStreamPart<ToolSet>,
): SSEEvent | null {
  const timestamp = new Date().toISOString();

  switch (chunk.type) {
    case "reasoning": {
      const event: ThinkingEvent = {
        id: getUniqueId("reasoning", prevChunk?.type),
        type: "thinking",
        data: { content: chunk.text },
        timestamp,
      };
      return event;
    }

    case "text": {
      const event: MessageEvent = {
        id: getUniqueId("text", prevChunk?.type),
        type: "text",
        data: { content: chunk.text || "" },
        timestamp,
      };
      return event;
    }

    case "tool-call": {
      const event: ToolCallEvent = {
        id: getUniqueId("tool_call"),
        type: "tool_call",
        data: {
          content: `Calling ${chunk.toolName}`,
          toolName: chunk.toolName,
          args: chunk.input,
          toolCallId: chunk.toolCallId,
        },
        timestamp,
      };
      return event;
    }

    case "finish": {
      const event: FinishEvent = {
        id: getUniqueId("tool_call"),
        type: "finish",
        data: { content: chunk.finishReason },
        timestamp,
      };
      return event;
    }

    case "error": {
      const event: ErrorEvent = {
        id: getUniqueId("tool_call"),
        type: "error",
        data: { content: JSON.stringify(chunk.error, null, 2) },
        timestamp,
      };
      return event;
    }

    default:
      // Skip unhandled chunk types
      return null;
  }
}

/**
 * Create a request event for user messages.
 * This is typically sent at the beginning of a conversation turn.
 */
export function createRequestEvent(content: string): RequestEvent {
  return {
    id: crypto.randomUUID(),
    type: "request",
    data: {
      content,
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Reset the stream ID tracker.
 * Call this between conversation turns to ensure fresh IDs.
 */
export function resetStreamIdTracker(): void {
  currentStreamId = undefined;
}

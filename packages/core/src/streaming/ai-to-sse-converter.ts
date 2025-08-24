/**
 * AI SDK to SSE Event Converter
 *
 * Converts streams from the AI SDK (used by conversation agent)
 * to the SSE event format expected by the message buffer in the CLI.
 */

import type {
  ErrorEvent,
  FinishEvent,
  MessageEvent,
  RequestEvent,
  SSEEvent,
  ThinkingEvent,
  ToolCallEvent,
} from "@atlas/config";
import type { TextStreamPart, ToolSet } from "ai";

// Track unique IDs for streaming events that share the same ID
let currentStreamId: string | undefined;

type NormalizedType = "text" | "reasoning" | "tool_call" | "tool_result" | "finish" | "error";

interface TextChunk {
  type: "text";
  text: string;
}

interface ReasoningChunk {
  type: "reasoning";
  text: string;
}

interface ToolCallChunk {
  type: "tool_call";
  toolName: string;
  input?: Record<string, unknown>;
  toolCallId?: string;
}

interface FinishChunk {
  type: "finish";
  finishReason?: string;
}

interface ErrorChunk {
  type: "error";
  error: unknown;
}

type NormalizedChunk = TextChunk | ReasoningChunk | ToolCallChunk | FinishChunk | ErrorChunk;

function normalizeType(type?: string): NormalizedType | undefined {
  if (!type) return undefined;
  const t = String(type).toLowerCase();

  // Primary content streams
  if (t === "text" || t.startsWith("text-")) return "text";
  if (t === "reasoning" || t.startsWith("reasoning-")) return "reasoning";

  // Tool interactions
  if (t === "tool-call" || t === "tool_call") return "tool_call";
  if (t === "tool-result" || t === "tool_result") return "tool_result";

  // Terminal and error states
  if (t === "error") return "error";
  if (t === "finish" || t === "finish-step" || t.endsWith("finish")) return "finish";

  // Non-display or structural events → skip
  if (t === "start" || t === "start-step") return undefined;
  if (t.startsWith("tool-input")) return undefined;

  // Unknown types: skip rather than leaking raw events to UI
  return undefined;
}

function toNormalizedChunk(part: TextStreamPart<ToolSet>): NormalizedChunk | undefined {
  const anyPart = part as unknown as Record<string, unknown> & {
    type?: string;
    text?: unknown;
    delta?: unknown;
    toolName?: string;
    input?: unknown;
    toolCallId?: string;
    finishReason?: string;
    error?: unknown;
  };

  const normalized = normalizeType(anyPart.type as string | undefined);
  if (!normalized) return undefined;

  const getText = (): string => {
    if (typeof anyPart.text === "string") return anyPart.text;
    if (typeof anyPart.delta === "string") return anyPart.delta;
    return "";
  };

  switch (normalized) {
    case "text":
      return { type: "text", text: getText() };
    case "reasoning":
      return { type: "reasoning", text: getText() };
    case "tool_call":
      return {
        type: "tool_call",
        toolName: (anyPart.toolName as string) ?? "tool",
        input: anyPart.input as Record<string, unknown> | undefined,
        toolCallId: anyPart.toolCallId as string | undefined,
      };
    case "finish":
      return { type: "finish", finishReason: anyPart.finishReason as string | undefined };
    case "error":
      return { type: "error", error: anyPart.error };
    case "tool_result":
    default:
      return undefined; // not displayed currently
  }
}

function getUniqueId(type: string, prevType?: string): string {
  const current = normalizeType(type);
  const previous = normalizeType(prevType);
  // For continuous text or thinking chunks, maintain the same ID
  if (current === previous && currentStreamId) {
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
  const prevType = prevChunk?.type;

  const normalizedChunk = toNormalizedChunk(chunk);
  if (!normalizedChunk) return null;

  switch (normalizedChunk.type) {
    case "reasoning": {
      const event: ThinkingEvent = {
        id: getUniqueId("reasoning", prevType),
        type: "thinking",
        data: { content: normalizedChunk.text },
        timestamp,
      };
      return event;
    }

    case "text": {
      const event: MessageEvent = {
        id: getUniqueId("text", prevType),
        type: "text",
        data: { content: normalizedChunk.text },
        timestamp,
      };
      return event;
    }

    case "tool_call": {
      const event: ToolCallEvent = {
        id: getUniqueId("tool_call"),
        type: "tool_call",
        data: {
          content: `Calling ${normalizedChunk.toolName}`,
          toolName: normalizedChunk.toolName,
          args: normalizedChunk.input,
          toolCallId: normalizedChunk.toolCallId,
        },
        timestamp,
      };
      return event;
    }

    case "finish": {
      const event: FinishEvent = {
        id: getUniqueId("finish"),
        type: "finish",
        data: { content: normalizedChunk.finishReason ?? "" },
        timestamp,
      };
      return event;
    }

    case "error": {
      const event: ErrorEvent = {
        id: getUniqueId("error"),
        type: "error",
        data: { content: JSON.stringify(normalizedChunk.error, null, 2) },
        timestamp,
      };
      return event;
    }

    default:
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
    data: { content },
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

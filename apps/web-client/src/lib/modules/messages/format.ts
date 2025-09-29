import {
  createErrorCause,
  getErrorDisplayMessage,
  isAPIErrorCause,
  type ErrorCause,
} from "@atlas/core/errors";
import type { UIDataTypes, UIMessagePart, UITools } from "ai";
import type { OutputEntry } from "./types.ts";

export function formatMessage(
  part: UIMessagePart<UIDataTypes, UITools>,
  currentUser: string | undefined,
): OutputEntry | undefined {
  if (part.type === "data-user-message") {
    return {
      id: crypto.randomUUID(),
      type: "request",
      timestamp: new Date().toISOString(),
      author: currentUser,
      content: String(part.data),
    };
  } else if (part.type === "reasoning") {
    return {
      id: crypto.randomUUID(),
      type: "thinking",
      timestamp: new Date().toISOString(),
      author: "Atlas",
      content: part.text,
    };
  } else if (part.type === "text") {
    return {
      id: crypto.randomUUID(),
      type: "text",
      timestamp: new Date().toISOString(),
      author: "Atlas",
      content: part.text,
    };
  } else if (part.type === "tool-table_output") {
    return {
      id: crypto.randomUUID(),
      type: "tool_call",
      timestamp: new Date().toISOString(),
      author: "Atlas",
      metadata: { toolName: "table_output", result: part.output },
    };
  } else if (part.type === "tool-workspace_summary") {
    return {
      id: crypto.randomUUID(),
      type: "tool_call",
      timestamp: new Date().toISOString(),
      author: "Atlas",
      metadata: { toolName: "workspace_summary", result: part.output },
    };
  } else if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
    // Check if tool had an error (AI SDK emits state: "output-error" for tool failures)
    if ("state" in part && part.state === "output-error" && "errorText" in part) {
      return {
        id: crypto.randomUUID(),
        type: "error",
        timestamp: new Date().toISOString(),
        author: "Atlas",
        content: `Tool error: ${String(part.errorText)}`,
        metadata: {
          toolName: "toolName" in part ? part.toolName : part.type.replace("tool-", ""),
          errorType: "tool-execution-error",
        },
      };
    }

    // Normal tool call
    return {
      id: crypto.randomUUID(),
      type: "tool_call",
      timestamp: new Date().toISOString(),
      author: "Atlas",
      metadata: {
        // example: tool-atlas_todo_read
        toolName: "toolName" in part ? part.toolName : part.type.replace("tool-", ""),
      },
    };
  } // @TODO: implement all of these
  else if (part.type.startsWith("tool-result-")) {
    return undefined;
  } else if (part.type === "data-agent-timeout") {
    return {
      id: crypto.randomUUID(),
      type: "error",
      timestamp: new Date().toISOString(),
      author: "Atlas",
      content: "Agent timed out",
    };
  } else if (part.type === "data-error" || part.type === "data-agent-error") {
    // Type-safe access to error data
    const errorData =
      "data" in part ? (part.data as { error?: string; errorCause?: ErrorCause }) : undefined;

    // Handle simple error format with errorText field
    const simpleErrorText =
      "errorText" in part && typeof (part as { errorText?: unknown }).errorText === "string"
        ? (part as { errorText: string }).errorText
        : undefined;

    // Extract structured error cause if available
    let errorCause = errorData?.errorCause;

    // Check if data is a plain string error message
    const dataAsString = "data" in part && typeof part.data === "string" ? part.data : undefined;

    // If we have a simple error text but no error cause, create one
    if (!errorCause && (simpleErrorText || dataAsString)) {
      // Create an error cause from the simple error text or data string
      const errorText = simpleErrorText || dataAsString;
      const error = new Error(errorText);
      const createdCause = createErrorCause(error);
      errorCause = createdCause;
    }

    // Use the provided error message, or generate a user-friendly one based on error type
    const errorMessage = errorCause
      ? getErrorDisplayMessage(errorCause)
      : errorData?.error || "An error occurred while processing your request.";

    if (errorCause) {
      return {
        id: crypto.randomUUID(),
        type: "error",
        timestamp: new Date().toISOString(),
        author: "Atlas",
        content: errorMessage,
        metadata: {
          errorCode: errorCause.code,
          errorType: errorCause.type,
          statusCode: isAPIErrorCause(errorCause) ? errorCause.statusCode : undefined,
          isRetryable: isAPIErrorCause(errorCause) ? errorCause.isRetryable : undefined,
          retryAfter: isAPIErrorCause(errorCause) ? errorCause.retryAfter : undefined,
          url: isAPIErrorCause(errorCause) ? errorCause.url : undefined,
        },
      };
    }

    // Fallback for legacy errors (temporary until all errors use causes)
    return {
      id: crypto.randomUUID(),
      type: "error",
      timestamp: new Date().toISOString(),
      author: "Atlas",
      content: errorMessage,
    };
  }
}

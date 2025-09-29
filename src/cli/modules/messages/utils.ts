import type { SessionUIMessagePart } from "@atlas/core";
import {
  createErrorCause,
  getErrorDisplayMessage,
  type APIErrorCause,
  type ErrorCause,
} from "@atlas/core/errors";
import type { OutputEntry } from "../conversation/types.ts";

export function formatMessage(part: SessionUIMessagePart): OutputEntry | undefined {
  const currentUser = Deno.env.get("USER") || Deno.env.get("USERNAME") || "You";

  if (part.type === "data-user-message") {
    return {
      id: crypto.randomUUID(),
      type: "request",
      timestamp: new Date().toISOString(),
      author: currentUser,
      content: String(part.data),
    };
  } else if (part.type === "reasoning" && part.state === "done") {
    return {
      id: crypto.randomUUID(),
      type: "thinking",
      timestamp: new Date().toISOString(),
      author: "Atlas",
      content: part.text,
    };
  } else if (part.type === "text" && part.state === "done") {
    return {
      id: crypto.randomUUID(),
      type: "text",
      timestamp: new Date().toISOString(),
      author: "Atlas",
      content: part.text,
    };
  } else if (part.type === "tool-table_output" && part.state === "output-available") {
    return {
      id: crypto.randomUUID(),
      type: "tool_call",
      timestamp: new Date().toISOString(),
      author: "Atlas",
      metadata: { toolName: "table_output", result: part.output },
    };
  } else if (
    (part.type.startsWith("tool-") && part.type !== "tool-table_output") ||
    part.type === "dynamic-tool"
  ) {
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
  } else if (part.type === "data-session-cancel") {
    const reason = part.data?.reason || "Session cancelled by user";
    return {
      id: crypto.randomUUID(),
      type: "text",
      timestamp: new Date().toISOString(),
      author: "Atlas",
      content: reason,
    };
  } else if (part.type === "data-agent-timeout") {
    return {
      id: crypto.randomUUID(),
      type: "error",
      timestamp: new Date().toISOString(),
      author: "Atlas",
      content: "Agent timed out",
    };
  } else if (
    "type" in part &&
    (part.type === "data-agent-error" || (part as { type: string }).type === "data-error")
  ) {
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
    let displayMessage = errorData?.error || dataAsString;

    if (!displayMessage && errorCause) {
      // Generate user-friendly messages based on error type and code
      displayMessage = getErrorDisplayMessage(errorCause);
    }

    // Final fallback - should rarely be needed now
    const errorMessage = displayMessage || "An error occurred while processing your request.";

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
          statusCode:
            errorCause.type === "api" ? (errorCause as APIErrorCause).statusCode : undefined,
          isRetryable:
            errorCause.type === "api" ? (errorCause as APIErrorCause).isRetryable : undefined,
          retryAfter:
            errorCause.type === "api" ? (errorCause as APIErrorCause).retryAfter : undefined,
          url: errorCause.type === "api" ? (errorCause as APIErrorCause).url : undefined,
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

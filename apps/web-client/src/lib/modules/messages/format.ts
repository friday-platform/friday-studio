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
  } else if (part.type === "tool-display_artifact") {
    return {
      id: crypto.randomUUID(),
      type: "tool_call",
      timestamp: new Date().toISOString(),
      author: "Atlas",
      // @ts-expect-error: this is accurate but poorly typed right now
      metadata: { toolName: "display_artifact", artifactId: part?.output?.artifactId },
    };
  } else if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
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
  } else if (
    part.type === "tool-error" ||
    part.type === "data-error" ||
    part.type === "data-agent-error"
  ) {
    // Extract actual error message from the data payload
    const errorMessage =
      part.data && typeof part.data === "object" && "error" in part.data
        ? String(part.data.error)
        : "Something went wrong";

    return {
      id: crypto.randomUUID(),
      type: "error",
      timestamp: new Date().toISOString(),
      author: "Atlas",
      content: errorMessage,
    };
  }
}

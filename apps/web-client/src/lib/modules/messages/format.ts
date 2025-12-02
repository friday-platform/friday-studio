import type { AtlasUIMessage, AtlasUIMessagePart } from "@atlas/agent-sdk";
import type { OutputEntry } from "./types.ts";

export function formatMessage(
  message: AtlasUIMessage,
  part: AtlasUIMessagePart,
): OutputEntry | undefined {
  if (message.role === "user") {
    if (part.type === "text") {
      return {
        id: message.id,
        type: "request",
        timestamp: new Date().toISOString(),
        content: String(part.text),
      };
    }
  }

  if (message.role === "assistant") {
    if (part.type === "reasoning") {
      return {
        id: crypto.randomUUID(),
        type: "reasoning",
        timestamp: new Date().toISOString(),
        content: part.text,
      };
    } else if (part.type === "text") {
      return {
        id: crypto.randomUUID(),
        type: "text",
        timestamp: new Date().toISOString(),
        content: part.text,
      };
    } else if (part.type === "tool-table_output") {
      return {
        id: crypto.randomUUID(),
        type: "tool_call",
        timestamp: new Date().toISOString(),
        metadata: { toolName: "table_output", result: part.output },
      };
    } else if (part.type === "tool-workspace_summary") {
      return {
        id: crypto.randomUUID(),
        type: "tool_call",
        timestamp: new Date().toISOString(),
        metadata: { toolName: "workspace_summary", result: part.output },
      };
    } else if (part.type === "tool-display_artifact") {
      return {
        id: crypto.randomUUID(),
        type: "tool_call",
        timestamp: new Date().toISOString(),
        // @TODO: fix
        metadata: { toolName: "display_artifact", artifactId: part?.output?.artifactId ?? "" },
      };
    } else if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
      return {
        id: crypto.randomUUID(),
        type: "tool_call",
        timestamp: new Date().toISOString(),
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
        content: "Agent timed out",
      };
    } else if (part.type === "data-error") {
      return {
        id: crypto.randomUUID(),
        type: "error",
        timestamp: new Date().toISOString(),
        content: part.data.error,
      };
    } else if (part.type === "tool-error") {
      return {
        id: crypto.randomUUID(),
        type: "error",
        timestamp: new Date().toISOString(),
        content: part.errorText,
      };
    } else if (part.type === "data-agent-error") {
      return {
        id: crypto.randomUUID(),
        type: "error",
        timestamp: new Date().toISOString(),
        content: part.data.error,
      };
    }
  }
}

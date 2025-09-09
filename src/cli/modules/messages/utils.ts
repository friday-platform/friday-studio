import type { SessionUIMessagePart } from "@atlas/core";
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
  } else if (part.type === "tool-error" || part.type === "data-agent-error") {
    return {
      id: crypto.randomUUID(),
      type: "error",
      timestamp: new Date().toISOString(),
      author: "Atlas",
      content: "Something went wrong",
    };
  }
}

export function getNormalizedToolName(toolName: string) {
  if (toolName === "atlas_todo_read") {
    return "Reading Todos";
  }

  if (toolName === "atlas_workspace_list") {
    return "Reading Workspaces";
  }

  if (toolName === "atlas_workspace_create") {
    return "Creating Workspace";
  }

  return toolName;
}

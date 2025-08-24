import type { SSEEvent } from "@atlas/config";
import type { OutputEntry } from "../conversation/types.ts";

export function formatMessage(messages: SSEEvent[]): OutputEntry | undefined {
  const currentUser = Deno.env.get("USER") || Deno.env.get("USERNAME") || "You";

  const firstMessage = messages[0];

  if (!firstMessage) {
    return;
  }

  const normalizedType = firstMessage.type;
  const { content: _, ...metadata } = firstMessage.data;

  return {
    id: firstMessage.id,
    type: normalizedType as OutputEntry["type"],
    timestamp: firstMessage.timestamp,
    author: normalizedType === "text" ? "Atlas" : currentUser,
    content: messages.map((message) => message.data.content).join(""),
    metadata,
  };
}

export function getGroupedMessages(messageValues: SSEEvent[]) {
  return messageValues.reduce(
    (groups, message) => {
      const id = message.id;
      if (!groups[id]) {
        groups[id] = [];
      }

      groups[id].push(message);

      return groups;
    },
    {} as Record<string, SSEEvent[]>,
  );
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

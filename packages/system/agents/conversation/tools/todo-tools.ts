/**
 * Todo Tools - SDK Architecture
 * Adapted from packages/tools/src/internal/todo.ts
 *
 * Manages todo lists for conversation sessions with persistent memory
 */

import { TodoItemSchema } from "@atlas/config";
import { createAtlasClient } from "@atlas/oapi-client";
import { tool } from "ai";
import { z } from "zod/v4";

// Helper to safely extract error message from unknown error
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export const todoReadTool = tool({
  description: "Read current todo list for the session to understand completed and pending tasks.",
  inputSchema: z.object({
    streamId: z.string().describe("Stream identifier for the conversation session"),
  }),
  execute: async ({ streamId }) => {
    try {
      const client = createAtlasClient();
      const response = await client.GET("/api/todos/{streamId}", {
        params: { path: { streamId } },
      });

      if (response.error) {
        throw new Error(`API error (${response.response.status}): ${response.error.error}`);
      }

      return {
        success: true,
        streamId,
        todos: response.data.todos || [],
        todoCount: response.data.todoCount || 0,
      };
    } catch (error) {
      throw new Error(`Failed to read todos: ${getErrorMessage(error)}`);
    }
  },
});

export const todoWriteTool = tool({
  description:
    "Create and manage structured task list for conversation session. Use this to track progress, store context about completed work, and plan multi-step tasks. Always provide the complete todo list to replace existing todos.",
  inputSchema: z.object({
    streamId: z.string().describe("Stream identifier for the conversation session"),
    todos: z
      .array(TodoItemSchema)
      .describe(
        "Complete todo list to store. This replaces the existing list, so include all todos you want to keep.",
      ),
  }),
  execute: async ({ streamId, todos }) => {
    try {
      const client = createAtlasClient();
      const response = await client.POST("/api/todos/{streamId}", {
        params: { path: { streamId } },
        body: { todos: todos },
      });

      if (response.error) {
        throw new Error(`API error (${response.response.status}): ${response.error.error}`);
      }

      return {
        success: true,
        streamId,
        todosStored: todos.length,
        message: response.data.message || "Todos stored successfully",
      };
    } catch (error) {
      throw new Error(`Failed to write todos: ${getErrorMessage(error)}`);
    }
  },
});

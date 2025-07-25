/**
 * Todo tools for Atlas
 * Handles todo list management with persistent memory across conversation sessions
 */

import { z } from "zod/v4";
import { tool } from "ai";
import { createAtlasClient } from "@atlas/oapi-client";
import { getErrorMessage } from "../utils.ts";

// Todo item schema
const TodoItemSchema = z.object({
  id: z.string().describe("Unique identifier for the todo item"),
  content: z.string().min(1).describe("Brief description of the task"),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"])
    .describe("Current status of the task"),
  priority: z.enum(["high", "medium", "low"])
    .describe("Priority level of the task"),
  metadata: z.record(z.string(), z.unknown()).optional()
    .describe("Additional context (workspace names, IDs, etc.)"),
  createdAt: z.string().describe("ISO timestamp of creation"),
  updatedAt: z.string().describe("ISO timestamp of last update"),
});

/**
 * Todo read tool - Read current todo list for the session
 */
export const atlas_todo_read = tool({
  description:
    "Read current todo list for the session to understand completed and pending tasks. Use this at the start of conversations to understand context and avoid recreating resources.",
  inputSchema: z.object({
    streamId: z.string().describe("Stream identifier for the conversation session"),
    status: z.enum(["pending", "in_progress", "completed", "cancelled"]).optional()
      .describe("Filter todos by status to focus on specific task states"),
    priority: z.enum(["high", "medium", "low"]).optional()
      .describe("Filter todos by priority level"),
    limit: z.number().optional().describe("Maximum number of todos to return"),
  }),
  execute: async ({ streamId, status, priority, limit }) => {
    try {
      const client = createAtlasClient();
      const response = await client.GET("/api/todo-storage/{streamId}", {
        params: {
          path: { streamId },
          query: { status, priority, limit },
        },
      });

      if (response.error) {
        throw new Error(`API error (${response.response.status}): ${response.error.error}`);
      }

      return {
        success: true,
        streamId,
        todos: response.data.todos || [],
        todoCount: response.data.todoCount || 0,
        filters: { status, priority, limit },
      };
    } catch (error) {
      throw new Error(`Failed to read todos: ${getErrorMessage(error)}`);
    }
  },
});

/**
 * Todo write tool - Create and manage structured task list for conversation session
 */
export const atlas_todo_write = tool({
  description:
    "Create and manage structured task list for conversation session. Use this to track progress, store context about completed work, and plan multi-step tasks. Always provide the complete todo list to replace existing todos.",
  inputSchema: z.object({
    streamId: z.string().describe("Stream identifier for the conversation session"),
    todos: z.array(TodoItemSchema).describe(
      "Complete todo list to store. This replaces the existing list, so include all todos you want to keep.",
    ),
  }),
  execute: async ({ streamId, todos }) => {
    try {
      // Validate all todos before sending
      const validatedTodos = todos.map((todo) => TodoItemSchema.parse(todo));

      const client = createAtlasClient();
      const response = await client.POST("/api/todo-storage/{streamId}", {
        params: {
          path: { streamId },
        },
        body: {
          todos: validatedTodos,
        },
      });

      if (response.error) {
        throw new Error(`API error (${response.response.status}): ${response.error.error}`);
      }

      return {
        success: true,
        streamId,
        todosStored: validatedTodos.length,
        message: response.data.message || "Todos stored successfully",
      };
    } catch (error) {
      throw new Error(`Failed to write todos: ${getErrorMessage(error)}`);
    }
  },
});

/**
 * Export all todo tools
 */
export const todoTools = {
  atlas_todo_read,
  atlas_todo_write,
};

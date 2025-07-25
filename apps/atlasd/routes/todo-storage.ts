import { z } from "zod/v4";
import { daemonFactory } from "../src/factory.ts";
import { describeRoute, resolver, validator } from "hono-openapi";
import { InMemoryTodoStorage } from "../../../src/core/daemon-capabilities.ts";

const todoStorageRoutes = daemonFactory.createApp();
const todoItemSchema = z.object({
  id: z.string().meta({ description: "Unique identifier for the todo item" }),
  content: z.string().min(1).meta({ description: "Brief description of the task" }),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"])
    .meta({ description: "Current status of the task" }),
  priority: z.enum(["high", "medium", "low"])
    .meta({ description: "Priority level of the task" }),
  metadata: z.record(z.string(), z.unknown()).optional()
    .meta({ description: "Additional context (workspace names, IDs, etc.)" }),
  createdAt: z.string().meta({ description: "ISO timestamp of creation" }),
  updatedAt: z.string().meta({ description: "ISO timestamp of last update" }),
}).meta({ description: "Todo item structure" });

const storeTodosSchema = z.object({
  todos: z.array(todoItemSchema).meta({ description: "Complete todo list to store" }),
}).meta({ description: "Todo list data to store" });

const getTodosQuerySchema = z.object({
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]).optional()
    .meta({ description: "Filter todos by status" }),
  priority: z.enum(["high", "medium", "low"]).optional()
    .meta({ description: "Filter todos by priority" }),
  limit: z.coerce.number().optional().meta({ description: "Maximum number of todos to return" }),
}).meta({ description: "Query parameters for todo filtering" });

const streamIdParamSchema = z.object({
  streamId: z.string().min(1).meta({ description: "Stream ID for todo operations" }),
}).meta({ description: "Stream ID parameter" });

const todoListResponseSchema = z.object({
  success: z.boolean(),
  todos: z.array(todoItemSchema),
  todoCount: z.number(),
}).meta({ description: "Todo list response" });

const storeResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  error: z.string().optional(),
}).meta({ description: "Store todos response" });

const deleteResponseSchema = z.object({
  success: z.boolean(),
  deleted: z.boolean().optional(),
  error: z.string().optional(),
}).meta({ description: "Delete todos response" });

const streamListResponseSchema = z.object({
  success: z.boolean(),
  streams: z.array(z.string()),
  total: z.number(),
}).meta({ description: "Stream list response" });

const errorResponseSchema = z.object({
  error: z.string(),
}).meta({ description: "Standard error response" });

todoStorageRoutes.post(
  "/api/todo-storage/:streamId",
  describeRoute({
    tags: ["Todo Storage"],
    summary: "Store todo list",
    description: "Store or update the complete todo list for the given stream ID",
    responses: {
      200: {
        description: "Todos stored successfully",
        content: {
          "application/json": {
            schema: resolver(storeResponseSchema),
          },
        },
      },
      400: {
        description: "Invalid request data",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
      500: {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  validator("param", streamIdParamSchema),
  validator("json", storeTodosSchema),
  (c) => {
    try {
      const { streamId } = c.req.valid("param");
      const { todos } = c.req.valid("json");

      const storage = InMemoryTodoStorage.getInstance();
      storage.storeTodos(streamId, todos);

      return c.json({
        success: true,
        message: `${todos.length} todos stored successfully`,
      });
    } catch (error) {
      return c.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

todoStorageRoutes.get(
  "/api/todo-storage/:streamId",
  describeRoute({
    tags: ["Todo Storage"],
    summary: "Retrieve todo list",
    description: "Get the todo list for the given stream ID with optional filtering",
    responses: {
      200: {
        description: "Todo list retrieved successfully",
        content: {
          "application/json": {
            schema: resolver(todoListResponseSchema),
          },
        },
      },
      404: {
        description: "Stream not found",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
      500: {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  validator("param", streamIdParamSchema),
  validator("query", getTodosQuerySchema),
  (c) => {
    try {
      const { streamId } = c.req.valid("param");
      const { status, priority, limit } = c.req.valid("query");

      const storage = InMemoryTodoStorage.getInstance();
      const todos = storage.getTodos(streamId, { status, priority, limit });

      return c.json({
        success: true,
        todos,
        todoCount: todos.length,
      });
    } catch (error) {
      return c.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

todoStorageRoutes.delete(
  "/api/todo-storage/:streamId",
  describeRoute({
    tags: ["Todo Storage"],
    summary: "Delete todo list",
    description: "Delete all todos for the given stream ID",
    responses: {
      200: {
        description: "Todos deleted successfully",
        content: {
          "application/json": {
            schema: resolver(deleteResponseSchema),
          },
        },
      },
      404: {
        description: "Stream not found",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
      500: {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  validator("param", streamIdParamSchema),
  (c) => {
    try {
      const { streamId } = c.req.valid("param");

      const storage = InMemoryTodoStorage.getInstance();
      // Check if todos exist for response info
      const existingTodos = storage.getTodos(streamId);
      const existed = existingTodos.length > 0;

      storage.clearTodos(streamId);

      return c.json({
        success: true,
        deleted: existed,
      });
    } catch (error) {
      return c.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

todoStorageRoutes.get(
  "/api/todo-storage",
  describeRoute({
    tags: ["Todo Storage"],
    summary: "List all todo streams",
    description: "Get a list of all stream IDs that have todo data (admin endpoint)",
    responses: {
      200: {
        description: "Stream list retrieved successfully",
        content: {
          "application/json": {
            schema: resolver(streamListResponseSchema),
          },
        },
      },
      500: {
        description: "Internal server error",
        content: {
          "application/json": {
            schema: resolver(errorResponseSchema),
          },
        },
      },
    },
  }),
  (c) => {
    try {
      const storage = InMemoryTodoStorage.getInstance();
      const streams = storage.listStreams();

      return c.json({
        success: true,
        streams,
        total: streams.length,
      });
    } catch (error) {
      return c.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

export { todoStorageRoutes };

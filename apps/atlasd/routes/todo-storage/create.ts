import { daemonFactory } from "../../src/factory.ts";
import { describeRoute, resolver, validator } from "hono-openapi";
import { InMemoryTodoStorage } from "../../../../src/core/daemon-capabilities.ts";
import {
  errorResponseSchema,
  storeResponseSchema,
  storeTodosSchema,
  streamIdParamSchema,
} from "./schemas.ts";

const createTodos = daemonFactory.createApp();

createTodos.post(
  "/",
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

export { createTodos };

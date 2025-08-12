import { daemonFactory } from "../../src/factory.ts";
import { describeRoute, resolver, validator } from "hono-openapi";
import { InMemoryTodoStorage } from "../../../../src/core/daemon-capabilities.ts";
import { errorResponseSchema, streamIdParamSchema, todoListResponseSchema } from "./schemas.ts";

const getTodos = daemonFactory.createApp();

getTodos.get(
  "/",
  describeRoute({
    tags: ["Todo Storage"],
    summary: "Retrieve todo list",
    description: "Get the todo list for the given stream ID",
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
  (c) => {
    try {
      const { streamId } = c.req.valid("param");

      const storage = InMemoryTodoStorage.getInstance();
      const todos = storage.getTodos(streamId);

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

export { getTodos };

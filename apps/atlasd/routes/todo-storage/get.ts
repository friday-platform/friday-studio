import { TodoItemSchema } from "@atlas/config";
import { todoStorage } from "@atlas/core";
import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod/v4";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";

const getTodos = daemonFactory.createApp();

/**
 * GET /:streamId - Retrieve todo list for a stream.
 *
 * Returns the complete todo list for the stream, or empty array if none exists.
 */
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
            schema: resolver(z.object({ todos: z.array(TodoItemSchema), todoCount: z.number() })),
          },
        },
      },
      404: {
        description: "Stream not found",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("param", z.object({ streamId: z.string() })),
  (c) => {
    try {
      const { streamId } = c.req.valid("param");
      const todos = todoStorage.get(streamId);

      return c.json({ todos, todoCount: todos.length });
    } catch (error) {
      return c.json({ error: stringifyError(error) }, 500);
    }
  },
);

export { getTodos };

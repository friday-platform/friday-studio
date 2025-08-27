import { TodoItemSchema } from "@atlas/config";
import { todoStorage } from "@atlas/core";
import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod/v4";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";

const createTodos = daemonFactory.createApp();

/**
 * POST /:streamId - Store complete todo list for a stream.
 *
 * Replaces any existing todos for the stream with the provided list.
 */
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
            schema: resolver(z.object({ success: z.boolean(), message: z.string().optional() })),
          },
        },
      },
      400: {
        description: "Invalid request data",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("param", z.object({ streamId: z.string() })),
  validator("json", z.object({ todos: z.array(TodoItemSchema) })),
  (c) => {
    try {
      const { streamId } = c.req.valid("param");
      const { todos } = c.req.valid("json");

      todoStorage.set(streamId, todos);

      return c.json({ success: true, message: `${todos.length} todos stored successfully` });
    } catch (error) {
      return c.json({ error: stringifyError(error) }, 500);
    }
  },
);

export { createTodos };

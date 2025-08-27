import { todoStorage } from "@atlas/core";
import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod/v4";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";

const deleteTodos = daemonFactory.createApp();

/**
 * DELETE /:streamId - Delete all todos for a stream.
 *
 * Removes all todo data for the stream and reports whether data existed.
 */
deleteTodos.delete(
  "/",
  describeRoute({
    tags: ["Todo Storage"],
    summary: "Delete todo list",
    description: "Delete all todos for the given stream ID",
    responses: {
      200: {
        description: "Todos deleted successfully",
        content: {
          "application/json": {
            schema: resolver(z.object({ success: z.boolean(), deleted: z.boolean() })),
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

      const existingTodos = todoStorage.get(streamId);
      const existed = existingTodos.length > 0;

      todoStorage.delete(streamId);

      return c.json({ success: true, deleted: existed });
    } catch (error) {
      return c.json({ error: stringifyError(error) }, 500);
    }
  },
);

export { deleteTodos };

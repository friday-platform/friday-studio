import { describeRoute, resolver, validator } from "hono-openapi";
import { InMemoryTodoStorage } from "../../../../src/core/daemon-capabilities.ts";
import { daemonFactory } from "../../src/factory.ts";
import { deleteResponseSchema, errorResponseSchema, streamIdParamSchema } from "./schemas.ts";

const deleteTodos = daemonFactory.createApp();

deleteTodos.delete(
  "/",
  describeRoute({
    tags: ["Todo Storage"],
    summary: "Delete todo list",
    description: "Delete all todos for the given stream ID",
    responses: {
      200: {
        description: "Todos deleted successfully",
        content: { "application/json": { schema: resolver(deleteResponseSchema) } },
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
  validator("param", streamIdParamSchema),
  (c) => {
    try {
      const { streamId } = c.req.valid("param");

      const storage = InMemoryTodoStorage.getInstance();
      // Check if todos exist for response info
      const existingTodos = storage.getTodos(streamId);
      const existed = existingTodos.length > 0;

      storage.clearTodos(streamId);

      return c.json({ success: true, deleted: existed });
    } catch (error) {
      return c.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

export { deleteTodos };

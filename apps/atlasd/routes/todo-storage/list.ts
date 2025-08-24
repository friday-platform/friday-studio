import { describeRoute, resolver } from "hono-openapi";
import { InMemoryTodoStorage } from "../../../../src/core/daemon-capabilities.ts";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema, streamListResponseSchema } from "./schemas.ts";

const listTodoStreams = daemonFactory.createApp();

listTodoStreams.get(
  "/",
  describeRoute({
    tags: ["Todo Storage"],
    summary: "List all todo streams",
    description: "Get a list of all stream IDs that have todo data (admin endpoint)",
    responses: {
      200: {
        description: "Stream list retrieved successfully",
        content: { "application/json": { schema: resolver(streamListResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  (c) => {
    try {
      const storage = InMemoryTodoStorage.getInstance();
      const streams = storage.listStreams();

      return c.json({ success: true, streams, total: streams.length });
    } catch (error) {
      return c.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        500,
      );
    }
  },
);

export { listTodoStreams };

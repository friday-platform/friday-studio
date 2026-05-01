import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver } from "hono-openapi";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";
import { libraryStatsSchema } from "./schemas.ts";

const getLibraryStats = daemonFactory.createApp();

/**
 * GET / - Get library statistics.
 *
 * Returns usage statistics for the library including item counts,
 * total size, and recent activity.
 */
getLibraryStats.get(
  "/",
  describeRoute({
    tags: ["Library"],
    summary: "Get library statistics",
    description:
      "Get usage statistics for the library including item counts, sizes, and recent activity.",
    responses: {
      200: {
        description: "Library statistics retrieved successfully",
        content: { "application/json": { schema: resolver(libraryStatsSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    try {
      const app = c.get("app");
      const libraryStorage = app.getLibraryStorage();

      const stats = await libraryStorage.getStats();
      return c.json(stats);
    } catch (error) {
      logger.error("Failed to get library stats", { error });
      return c.json({ error: `Failed to get library stats: ${stringifyError(error)}` }, 500);
    }
  },
);

export { getLibraryStats };

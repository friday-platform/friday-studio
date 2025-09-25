import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver } from "hono-openapi";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";
import type { LibrarySearchQuery } from "./schemas.ts";
import { librarySearchResultSchema } from "./schemas.ts";

const listLibrary = daemonFactory.createApp();

/**
 * GET / - Search and list library items.
 *
 * Returns filtered library items based on search criteria.
 * Supports filtering by query text, type, tags, and date range.
 */
listLibrary.get(
  "/",
  describeRoute({
    tags: ["Library"],
    summary: "Search and list library items",
    description:
      "Search library items with optional filters for type, tags, date range, and text query. Returns paginated results.",
    responses: {
      200: {
        description: "Library search results",
        content: { "application/json": { schema: resolver(librarySearchResultSchema) } },
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

      // Parse query parameters manually for arrays
      const query: LibrarySearchQuery = {
        query: c.req.query("q") || c.req.query("query"),
        type: c.req.query("type") ? c.req.query("type").split(",") : undefined,
        tags: c.req.query("tags") ? c.req.query("tags").split(",") : undefined,
        since: c.req.query("since"),
        until: c.req.query("until"),
        limit: c.req.query("limit") ? parseInt(c.req.query("limit")) : 50,
        offset: c.req.query("offset") ? parseInt(c.req.query("offset")) : 0,
      };

      const result = await libraryStorage.search(query);
      return c.json(result);
    } catch (error) {
      return c.json({ error: `Failed to list library items: ${stringifyError(error)}` }, 500);
    }
  },
);

export { listLibrary };

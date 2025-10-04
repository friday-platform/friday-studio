import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod";
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
  validator(
    "query",
    z.object({
      query: z.string().optional(),
      q: z.string().optional(),
      type: z.string().optional(),
      tags: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      limit: z.string().optional(),
      offset: z.string().optional(),
    }),
  ),
  async (c) => {
    try {
      const app = c.get("app");
      const queryParams = c.req.valid("query");
      const libraryStorage = app.getLibraryStorage();

      // Parse query parameters manually for arrays
      const query: LibrarySearchQuery = {
        query: queryParams.query || queryParams.q,
        type: queryParams.type ? queryParams.type.split(",") : undefined,
        tags: queryParams.tags ? queryParams.tags.split(",") : undefined,
        since: queryParams.since,
        until: queryParams.until,
        limit: queryParams.limit ? parseInt(queryParams.limit, 10) : 50,
        offset: queryParams.offset ? parseInt(queryParams.offset, 10) : 0,
      };

      const result = await libraryStorage.search(query);
      return c.json(result);
    } catch (error) {
      return c.json({ error: `Failed to list library items: ${stringifyError(error)}` }, 500);
    }
  },
);

export { listLibrary };

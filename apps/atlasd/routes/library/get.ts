import { daemonFactory } from "../../src/factory.ts";
import { describeRoute, resolver } from "hono-openapi";
import { stringifyError } from "@atlas/utils";
import { logger } from "@atlas/logger";
import { errorResponseSchema } from "../../src/utils.ts";
import { getLibraryItemResponseSchema } from "./schemas.ts";
import { z } from "zod/v4";

const getLibraryItem = daemonFactory.createApp();

/**
 * GET /:itemId - Retrieve a specific library item.
 *
 * Returns library item metadata and optionally its content.
 * Use ?content=true to include the item's content in the response.
 */
getLibraryItem.get(
  "/",
  describeRoute({
    tags: ["Library"],
    summary: "Get library item by ID",
    description:
      "Retrieve a specific library item by its ID. Optionally include content by setting content=true query parameter.",
    responses: {
      200: {
        description: "Library item retrieved successfully",
        content: { "application/json": { schema: resolver(getLibraryItemResponseSchema) } },
      },
      404: {
        description: "Library item not found",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const itemId = c.req.param("itemId");
    const includeContent = c.req.query("content") === "true";

    try {
      const app = c.get("app");
      const libraryStorage = app.getLibraryStorage();

      const result = includeContent
        ? await libraryStorage.getItemWithContent(itemId)
        : await libraryStorage.getItem(itemId);

      if (!result) {
        return c.json({ error: `Library item not found: ${itemId}` }, 404);
      }

      if (includeContent && "content" in result) {
        return c.json({ item: result.item, content: result.content });
      } else {
        return c.json({ item: result.item });
      }
    } catch (error) {
      logger.error("Failed to get library item", { error, itemId });
      return c.json({ error: `Failed to get library item: ${stringifyError(error)}` }, 500);
    }
  },
);

export { getLibraryItem };

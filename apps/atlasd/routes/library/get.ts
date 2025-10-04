import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver, validator } from "hono-openapi";
import { z } from "zod";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";
import { getLibraryItemResponseSchema } from "./schemas.ts";

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
  validator("param", z.object({ itemId: z.string() })),
  validator("query", z.object({ content: z.literal("true").optional() })),
  async (c) => {
    const itemId = c.req.valid("param").itemId;
    const includeContent = c.req.valid("query").content;

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

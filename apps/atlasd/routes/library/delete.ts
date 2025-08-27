import { daemonFactory } from "../../src/factory.ts";
import { describeRoute, resolver } from "hono-openapi";
import { stringifyError } from "@atlas/utils";
import { logger } from "@atlas/logger";
import { errorResponseSchema } from "../../src/utils.ts";
import { deleteLibraryItemResponseSchema } from "./schemas.ts";

const deleteLibraryItem = daemonFactory.createApp();

/**
 * DELETE / - Delete a library item.
 *
 * Permanently removes a library item and its content.
 */
deleteLibraryItem.delete(
  "/",
  describeRoute({
    tags: ["Library"],
    summary: "Delete library item",
    description: "Permanently delete a library item and its content by ID.",
    responses: {
      200: {
        description: "Library item deleted successfully",
        content: { "application/json": { schema: resolver(deleteLibraryItemResponseSchema) } },
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

    try {
      const app = c.get("app");
      const libraryStorage = app.getLibraryStorage();

      const deleted = await libraryStorage.deleteItem(itemId);
      if (!deleted) {
        return c.json({ error: `Library item not found: ${itemId}` }, 404);
      }

      return c.json({ message: `Library item ${itemId} deleted` });
    } catch (error) {
      logger.error("Failed to delete library item", { error, itemId });
      return c.json({ error: `Failed to delete library item: ${stringifyError(error)}` }, 500);
    }
  },
);

export { deleteLibraryItem };

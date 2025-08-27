import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { describeRoute } from "hono-openapi";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";

const downloadLibraryItem = daemonFactory.createApp();

/**
 * GET /:itemId/download - Download a library item file
 *
 * Serves the actual file content with proper headers for download
 */
downloadLibraryItem.get(
  "/",
  describeRoute({
    tags: ["Library"],
    summary: "Download library item file",
    description: "Download the actual file content of a library item with proper headers.",
    parameters: [
      {
        name: "itemId",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "ID of the library item to download",
      },
    ],
    responses: {
      200: {
        description: "File content",
        content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
      },
      404: {
        description: "Item not found",
        content: { "application/json": { schema: errorResponseSchema } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: errorResponseSchema } },
      },
    },
  }),
  async (c) => {
    try {
      const app = c.get("app");
      const libraryStorage = app.getLibraryStorage();
      const itemId = c.req.param("itemId");

      if (!itemId) {
        return c.json({ error: "Item ID is required" }, 400);
      }

      // Get item with content
      const result = await libraryStorage.getItemWithContent(itemId);
      if (!result) {
        return c.json({ error: "Item not found" }, 404);
      }

      const { item, content } = result;

      // Set proper headers for download
      const headers = new Headers({
        "Content-Type": item.mime_type,
        "Content-Disposition": `attachment; filename="${item.name}"`,
        "Content-Length": item.size_bytes.toString(),
      });

      return new Response(content, { headers });
    } catch (error) {
      logger.error("Failed to download library item", { error });
      return c.json({ error: `Failed to download library item: ${stringifyError(error)}` }, 500);
    }
  },
);

export { downloadLibraryItem };

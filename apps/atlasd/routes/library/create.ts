import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver } from "hono-openapi";
import type { StoreItemInput } from "../../../../src/core/library/types.ts";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";
import { createLibraryItemResponseSchema, createLibraryItemSchema } from "./schemas.ts";

const createLibraryItem = daemonFactory.createApp();

/**
 * POST / - Create a new library item.
 *
 * Creates a new library item with the provided data and content.
 */
createLibraryItem.post(
  "/",
  describeRoute({
    tags: ["Library"],
    summary: "Create library item",
    description: "Create a new library item with content and metadata.",
    requestBody: {
      required: true,
      content: {
        "application/json": { schema: resolver(createLibraryItemSchema) },
        "multipart/form-data": {}, // Browser handles FormData structure
      },
    },
    responses: {
      201: {
        description: "Library item created successfully",
        content: { "application/json": { schema: resolver(createLibraryItemResponseSchema) } },
      },
      400: {
        description: "Invalid request",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
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

      const contentType = c.req.header("content-type") || "";

      let libraryItem: StoreItemInput;

      if (contentType.includes("multipart/form-data")) {
        // Handle File upload from web client
        const formData = await c.req.formData();
        const file = formData.get("file") as File;

        if (!file) {
          return c.json({ error: "file is required for file uploads" }, 400);
        }

        // Generate ID and timestamps
        const itemId = crypto.randomUUID();
        const now = new Date().toISOString();

        libraryItem = {
          id: itemId,
          source: "user",
          name: file.name,
          content: new Uint8Array(await file.arrayBuffer()),
          mime_type: file.type || "application/octet-stream",
          filename: file.name,
          created_at: now,
          updated_at: now,
          tags: [],
        };
      } else {
        // Handle JSON payload (for agents/CLI)
        const itemData = await c.req.json();

        // Validate required fields
        if (!itemData.type || !itemData.name || !itemData.content) {
          return c.json({ error: "type, name, and content are required" }, 400);
        }

        // Generate ID and timestamps
        const itemId = crypto.randomUUID();
        const now = new Date().toISOString();

        libraryItem = {
          id: itemId,
          source: itemData.source || "agent",
          name: itemData.name,
          description: itemData.description,
          content: itemData.content,
          mime_type: "text/plain", // Default for agent content
          session_id: itemData.session_id,
          agent_ids: itemData.agent_ids || [],
          created_at: now,
          updated_at: now,
          tags: itemData.tags || [],
          workspace_id: itemData.workspace_id,
          custom_fields: itemData.metadata || {},
        };
      }

      const fullPath = await libraryStorage.storeItem(libraryItem);

      return c.json(
        {
          success: true,
          itemId: libraryItem.id,
          message: `Library item '${libraryItem.name}' created`,
          item: libraryItem,
          path: fullPath,
        },
        201,
      );
    } catch (error) {
      logger.error("Failed to create library item", { error });
      return c.json({ error: `Failed to create library item: ${stringifyError(error)}` }, 500);
    }
  },
);

export { createLibraryItem };

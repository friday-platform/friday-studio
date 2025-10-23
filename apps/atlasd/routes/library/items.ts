import type { StoreItemInput } from "@atlas/core/library";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";
import {
  createLibraryItemRequestSchema,
  createLibraryItemResponseSchema,
  librarySearchQuerySchema,
  librarySearchQueryValidatorSchema,
  librarySearchResultSchema,
} from "./schemas.ts";

const libraryItems = daemonFactory.createApp();

/**
 * Convert file upload to StoreItemInput
 */
async function handleFileUpload(formData: FormData): Promise<StoreItemInput> {
  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new Error("file is required for file uploads");
  }

  const metadataJson = formData.get("metadata");
  const metadataInput: unknown = metadataJson ? JSON.parse(metadataJson.toString()) : {};
  const fileContent = new Uint8Array(await file.arrayBuffer());

  const validated = createLibraryItemRequestSchema
    .omit({ content: true })
    .parse({
      type: "user_upload",
      name: file.name,
      mime_type: file.type || "application/octet-stream",
      source: "user",
      ...(metadataInput && typeof metadataInput === "object" ? metadataInput : {}),
    });

  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    ...validated,
    content: fileContent,
    filename: file.name,
    custom_fields: validated.metadata,
  };
}

/**
 * Convert JSON payload to StoreItemInput
 */
function handleJsonPayload(json: unknown): StoreItemInput {
  const itemData = createLibraryItemRequestSchema.parse(json);
  const now = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    ...itemData,
    custom_fields: itemData.metadata,
  };
}

/**
 * GET / - Search and list library items.
 *
 * Returns filtered library items based on search criteria.
 * Supports filtering by query text, type, tags, and date range.
 */
libraryItems.get(
  "/",
  describeRoute({
    tags: ["Library"],
    summary: "Search and list library items",
    description:
      "Search library items with optional filters for type, tags, date range, and text query. Returns paginated results.",
    parameters: [
      { name: "query", in: "query", schema: { type: "string" }, description: "Search text" },
      { name: "q", in: "query", schema: { type: "string" }, description: "Search text (alias)" },
      {
        name: "type",
        in: "query",
        schema: { type: "string" },
        description: "Comma-separated item types to filter by",
      },
      {
        name: "tags",
        in: "query",
        schema: { type: "string" },
        description: "Comma-separated tags to filter by",
      },
      { name: "since", in: "query", schema: { type: "string" }, description: "Start date filter" },
      { name: "until", in: "query", schema: { type: "string" }, description: "End date filter" },
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        description: "Maximum items to return",
      },
      {
        name: "offset",
        in: "query",
        schema: { type: "integer", minimum: 0, default: 0 },
        description: "Number of items to skip",
      },
    ],
    responses: {
      200: {
        description: "Library search results",
        content: { "application/json": { schema: resolver(librarySearchResultSchema) } },
      },
      400: {
        description: "Invalid query parameters",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("query", librarySearchQueryValidatorSchema),
  async (c) => {
    try {
      const app = c.get("app");
      const libraryStorage = app.getLibraryStorage();
      const rawQuery = c.req.valid("query");

      // Transform raw query params to typed query (validator already coerced limit/offset to numbers)
      const query = librarySearchQuerySchema.parse({
        query: rawQuery.query || rawQuery.q,
        type: rawQuery.type
          ?.split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0),
        tags: rawQuery.tags
          ?.split(",")
          .map((t) => t.trim())
          .filter((t) => t.length > 0),
        since: rawQuery.since,
        until: rawQuery.until,
        limit: rawQuery.limit,
        offset: rawQuery.offset,
      });

      const result = await libraryStorage.search(query);
      return c.json(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issue = error.issues[0]!;
        return c.json({ error: `${issue.path.join(".")}: ${issue.message}` }, 400);
      }

      logger.error("Failed to list library items", { error });
      return c.json({ error: `Failed to list library items: ${stringifyError(error)}` }, 500);
    }
  },
);

/**
 * POST / - Create a new library item.
 *
 * Creates a new library item with the provided data and content.
 * Accepts either JSON payload (for agents/CLI) or multipart/form-data (for file uploads).
 */
libraryItems.post(
  "/",
  describeRoute({
    tags: ["Library"],
    summary: "Create library item",
    description:
      "Create a new library item with content and metadata. Accepts JSON or multipart/form-data.",
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

      // Parse request based on content type
      const libraryItem = contentType.includes("multipart/form-data")
        ? await handleFileUpload(await c.req.formData())
        : handleJsonPayload(await c.req.json());

      // Store item and get enhanced item structure directly
      const { path, item } = await libraryStorage.storeItem(libraryItem);

      return c.json(
        {
          success: true,
          itemId: libraryItem.id,
          message: `Library item '${libraryItem.name}' created`,
          item,
          path,
        },
        201,
      );
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issue = error.issues[0]!;
        return c.json({ error: `${issue.path.join(".")}: ${issue.message}` }, 400);
      }

      if (error instanceof Error && error.message.includes("required")) {
        return c.json({ error: error.message }, 400);
      }

      logger.error("Failed to create library item", { error });
      return c.json({ error: `Failed to create library item: ${stringifyError(error)}` }, 500);
    }
  },
);

export { libraryItems };

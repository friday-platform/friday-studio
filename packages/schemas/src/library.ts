import { z } from "zod";

/**
 * Library schemas for validation and type inference
 * Shared across API, client, and core packages
 */

// Library item types enum
export const LIBRARY_ITEM_TYPE = z.enum([
  "report",
  "session_archive",
  "template",
  "artifact",
  "user_upload",
]);

// Library metadata source enum
export const LIBRARY_SOURCE = z.enum(["agent", "job", "user", "system"]);

// Library item metadata schema
const libraryItemMetadataSchema = z.object({
  source: LIBRARY_SOURCE,
  session_id: z.string().optional(),
  agent_ids: z.array(z.string()).optional(),
  template_id: z.string().optional(),
  generated_by: z.string().optional(),
  custom_fields: z.record(z.string(), z.unknown()).optional(),
});

// Full library item schema (for responses)
export const libraryItemSchema = z.object({
  id: z.string(),
  type: LIBRARY_ITEM_TYPE,
  name: z.string(),
  description: z.string().optional(),
  content_path: z.string(),
  mime_type: z.string(),
  metadata: libraryItemMetadataSchema,
  created_at: z.string(),
  updated_at: z.string(),
  tags: z.array(z.string()),
  size_bytes: z.number(),
  workspace_id: z.string().optional(),
});

// Library search query schema
export const librarySearchQuerySchema = z.object({
  query: z.string().optional(),
  type: z.union([LIBRARY_ITEM_TYPE, z.array(LIBRARY_ITEM_TYPE)]).optional(),
  tags: z
    .array(
      z
        .string()
        .max(50, "Tag too long. Maximum length is 50 characters")
        .regex(
          /^[a-zA-Z0-9_.-]+$/,
          "Tags must contain only letters, numbers, hyphens, underscores, and dots",
        ),
    )
    .max(50, "Too many tags. Maximum is 50")
    .optional(),
  workspace: z.boolean().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
});

// Library search query validator schema (for query string parameters)
// Uses Zod coercion to automatically convert string params to correct types
export const librarySearchQueryValidatorSchema = z.object({
  query: z.string().optional(),
  q: z.string().optional(),
  type: z.string().optional(),
  tags: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

// Library search result schema
export const librarySearchResultSchema = z.object({
  items: z.array(libraryItemSchema),
  total: z.number(),
  query: librarySearchQuerySchema,
  took_ms: z.number(),
});

// Library stats schema
export const libraryStatsSchema = z.object({
  total_items: z.number(),
  total_size_bytes: z.number(),
  types: z.record(z.string(), z.number()),
  recent_activity: z.array(
    z.object({ date: z.string(), items_added: z.number(), items_modified: z.number() }),
  ),
});

// Template metadata schema
const templateMetadataSchema = z.object({
  version: z.string().optional(),
  author: z.string().optional(),
  tags: z.array(z.string()).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  usage_count: z.number().optional(),
});

// Template config schema
export const templateConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  mime_type: z.string(),
  engine: z.string(),
  config: z.record(z.string(), z.unknown()),
  schema: z.record(z.string(), z.unknown()).optional(),
  metadata: templateMetadataSchema.optional(),
});

// Create item request schema (JSON body)
export const createLibraryItemRequestSchema = z.object({
  type: LIBRARY_ITEM_TYPE,
  name: z.string().min(1).max(255),
  content: z.string().min(1),
  description: z.string().max(1000).optional(),
  mime_type: z.string().optional().default("text/plain"),
  source: LIBRARY_SOURCE.optional().default("agent"),
  session_id: z.string().optional(),
  agent_ids: z.array(z.string()).optional().default([]),
  tags: z.array(z.string()).optional().default([]),
  workspace_id: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional().default({}),
});

// Get item response schema (with optional content)
export const getLibraryItemResponseSchema = z.object({
  item: libraryItemSchema,
  content: z.string().optional(),
});

// Create item response schema
export const createLibraryItemResponseSchema = z.object({
  success: z.boolean(),
  itemId: z.string(),
  message: z.string(),
  item: libraryItemSchema,
  path: z.string(),
});

// Delete item response schema
export const deleteLibraryItemResponseSchema = z.object({ message: z.string() });

// Exported type aliases for convenience
export type LibrarySearchQuery = z.infer<typeof librarySearchQuerySchema>;
export type LibraryItem = z.infer<typeof libraryItemSchema>;
export type LibrarySearchResult = z.infer<typeof librarySearchResultSchema>;
export type LibraryStats = z.infer<typeof libraryStatsSchema>;
export type TemplateConfig = z.infer<typeof templateConfigSchema>;
export type CreateLibraryItemRequest = z.infer<typeof createLibraryItemRequestSchema>;

import { z } from "zod/v4";

/**
 * Library route schemas for validation and OpenAPI documentation
 */

// Library item types enum
export const LIBRARY_ITEM_TYPE = z.enum([
  "report",
  "session_archive",
  "template",
  "artifact",
  "user_upload",
]);

// Library metadata format enum
export const LIBRARY_FORMAT = z.enum(["markdown", "json", "html", "text", "binary"]);

// Library metadata source enum
export const LIBRARY_SOURCE = z.enum(["agent", "job", "user", "system"]);

// Library item metadata schema
export const libraryItemMetadataSchema = z.object({
  format: LIBRARY_FORMAT,
  source: LIBRARY_SOURCE,
  session_id: z.string().optional(),
  agent_ids: z.array(z.string()).optional(),
  template_id: z.string().optional(),
  generated_by: z.string().optional(),
  custom_fields: z.record(z.string(), z.any()).optional(),
});

// Full library item schema (for responses)
export const libraryItemSchema = z.object({
  id: z.string(),
  type: LIBRARY_ITEM_TYPE,
  name: z.string(),
  description: z.string().optional(),
  content_path: z.string(),
  metadata: libraryItemMetadataSchema,
  created_at: z.string(),
  updated_at: z.string(),
  tags: z.array(z.string()),
  size_bytes: z.number(),
  workspace_id: z.string().optional(),
});

// Create library item request schema
export const createLibraryItemSchema = z.object({
  type: LIBRARY_ITEM_TYPE,
  name: z.string().min(1),
  description: z.string().optional(),
  content: z.string(), // Required for creation
  format: LIBRARY_FORMAT.optional().default("markdown"),
  source: LIBRARY_SOURCE.optional().default("agent"),
  session_id: z.string().optional(),
  agent_ids: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional().default([]),
  workspace_id: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

// Library search query schema
export const librarySearchQuerySchema = z.object({
  query: z.string().optional(),
  type: z.union([z.string(), z.array(z.string())]).optional(),
  tags: z.array(z.string()).optional(),
  workspace: z.boolean().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
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
export const templateMetadataSchema = z.object({
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
  format: z.enum(["markdown", "json", "html", "text"]),
  engine: z.string(),
  config: z.record(z.string(), z.any()),
  schema: z.record(z.string(), z.any()).optional(),
  metadata: templateMetadataSchema.optional(),
});

// Generate from template request schema
export const generateFromTemplateSchema = z.object({
  templateId: z.string().min(1),
  data: z.record(z.string(), z.any()).optional(),
  options: z.record(z.string(), z.any()).optional(),
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
  item: z.object({
    id: z.string(),
    type: LIBRARY_ITEM_TYPE,
    name: z.string(),
    description: z.string(),
    content: z.string(),
    metadata: z
      .object({
        format: LIBRARY_FORMAT,
        source: LIBRARY_SOURCE,
        session_id: z.string().optional(),
        agent_ids: z.array(z.string()),
        // Allow additional fields
      })
      .passthrough(),
    created_at: z.string(),
    updated_at: z.string(),
    tags: z.array(z.string()),
    workspace_id: z.string().optional(),
  }),
});

// Delete item response schema
export const deleteLibraryItemResponseSchema = z.object({ message: z.string() });

// Generate template response schema (placeholder)
export const generateTemplateResponseSchema = z.object({
  message: z.string(),
  templateId: z.string(),
  data: z.any().optional(),
  options: z.any().optional(),
});

// Type exports for TypeScript usage
export type LibraryItem = z.infer<typeof libraryItemSchema>;
export type CreateLibraryItem = z.infer<typeof createLibraryItemSchema>;
export type LibrarySearchQuery = z.infer<typeof librarySearchQuerySchema>;
export type LibrarySearchResult = z.infer<typeof librarySearchResultSchema>;
export type LibraryStats = z.infer<typeof libraryStatsSchema>;
export type TemplateConfig = z.infer<typeof templateConfigSchema>;
export type GenerateFromTemplate = z.infer<typeof generateFromTemplateSchema>;

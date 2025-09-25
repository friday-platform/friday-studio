import { z } from "zod";

// Job schemas
export const JobInfoSchema = z.object({ name: z.string(), description: z.string().optional() });
export type JobInfo = z.infer<typeof JobInfoSchema>;

// Library schemas
const LibraryItemSchema = z.object({
  id: z.string(),
  source: z.enum(["agent", "job", "user", "system"]),
  name: z.string(),
  description: z.string().optional(),
  content_path: z.string(),
  full_path: z.string(),
  file_extension: z.string(),
  mime_type: z.string(),
  session_id: z.string().optional(),
  agent_ids: z.array(z.string()).optional(),
  template_id: z.string().optional(),
  generated_by: z.string().optional(),
  custom_fields: z.record(z.string(), z.unknown()).optional(),
  created_at: z.string(),
  updated_at: z.string(),
  tags: z.array(z.string()),
  size_bytes: z.number(),
  workspace_id: z.string().optional(),
});

export const LibraryItemWithContentSchema = z.object({
  item: LibraryItemSchema,
  content: z.union([z.string(), z.instanceof(Uint8Array)]).optional(),
});

export const LibraryItemMetadataResponseSchema = z.object({ item: LibraryItemSchema });
export const LibraryItemWithContentResponseSchema = z.object({
  item: LibraryItemSchema,
  content: z.union([z.string(), z.instanceof(Uint8Array)]),
});

export const LibrarySearchResultSchema = z.object({
  items: z.array(LibraryItemSchema),
  total: z.number(),
  query: z.record(z.string(), z.unknown()),
  took_ms: z.number(),
});
export type LibrarySearchResult = z.infer<typeof LibrarySearchResultSchema>;

export const LibraryStatsSchema = z.object({
  total_items: z.number(),
  total_size_bytes: z.number(),
  types: z.record(z.string(), z.number()),
});
export type LibraryStats = z.infer<typeof LibraryStatsSchema>;

export const LibraryStoreResponseSchema = z.object({
  success: z.boolean(),
  itemId: z.string(),
  message: z.string().optional(),
  item: z.object({ name: z.string().optional() }).optional(),
  path: z.string().optional(),
});
export type LibraryStoreResponse = z.infer<typeof LibraryStoreResponseSchema>;

// Session schemas
export const CancelSessionResponseSchema = z.object({
  message: z.string(),
  workspaceId: z.string(),
});

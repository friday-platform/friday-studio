// Core types for the Atlas Library system
// Re-exported from @atlas/schemas for single source of truth

import type { z } from "zod";
import type {
  libraryItemSchema,
  librarySearchQuerySchema,
  librarySearchResultSchema,
  libraryStatsSchema,
  templateConfigSchema,
} from "@atlas/schemas/library";

// Base LibraryItem from API schema
type BaseLibraryItem = z.infer<typeof libraryItemSchema>;

// Extended LibraryItem with storage-specific fields
export interface LibraryItem extends BaseLibraryItem {
  full_path?: string; // Full absolute path to content file (added by storage adapter)
  file_extension?: string; // File extension (.md, .pdf, .jpg, etc.) (added by storage adapter)
}

export interface StoreItemInput {
  id: string;
  type: "report" | "session_archive" | "template" | "artifact" | "user_upload";
  source: "agent" | "job" | "user" | "system";
  name: string;
  description?: string;
  content: string | Uint8Array;
  mime_type: string;
  filename?: string;
  session_id?: string;
  agent_ids?: string[];
  template_id?: string;
  generated_by?: string;
  custom_fields?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  tags: string[];
  workspace_id?: string;
}

// Re-export types from API schema
export type TemplateConfig = z.infer<typeof templateConfigSchema>;
export type LibrarySearchQuery = z.infer<typeof librarySearchQuerySchema>;
export type LibrarySearchResult = z.infer<typeof librarySearchResultSchema>;
export type LibraryStats = z.infer<typeof libraryStatsSchema>;

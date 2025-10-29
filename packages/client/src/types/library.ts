/**
 * Library-related type definitions
 * Re-exported from @atlas/schemas for convenience
 */

import type {
  libraryItemSchema,
  librarySearchQuerySchema,
  librarySearchResultSchema,
  libraryStatsSchema,
  templateConfigSchema,
} from "@atlas/schemas/library";
import type { z } from "zod";

export type LibrarySearchQuery = z.infer<typeof librarySearchQuerySchema>;
export type LibraryItem = z.infer<typeof libraryItemSchema>;
export type LibrarySearchResult = z.infer<typeof librarySearchResultSchema>;
export type LibraryStats = z.infer<typeof libraryStatsSchema>;
export type TemplateConfig = z.infer<typeof templateConfigSchema>;

export interface LibraryItemWithContent {
  item: LibraryItem;
  content?: string;
}

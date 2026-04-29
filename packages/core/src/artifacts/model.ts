import { z } from "zod";

/** Slug: lowercase alphanumeric + hyphens, with optional path segments separated by `/`. */
const SlugSchema = z.string().regex(/^[a-z0-9-]+(\/[a-z0-9-]+)*$/);

import { FileDataInputSchema, FileDataSchema } from "./primitives.ts";

/** Revision summary for history */
export interface ArtifactRevisionSummary {
  revision: number;
  createdAt: string;
  revisionMessage?: string;
}

const FileArtifactSchema = z.object({
  type: z.literal("file"),
  version: z.literal(1),
  data: FileDataSchema,
});

const FileArtifactInputSchema = z.object({
  type: z.literal("file"),
  version: z.literal(1),
  data: FileDataInputSchema,
});

/** Artifact data schema for storage (output) */
export const ArtifactDataSchema = FileArtifactSchema;

export type ArtifactType = "file";
export type ArtifactData = z.infer<typeof ArtifactDataSchema>;

/** Artifact data schema for creation (input) */
export const ArtifactDataInputSchema = FileArtifactInputSchema;

export type ArtifactDataInput = z.infer<typeof ArtifactDataInputSchema>;

/** Schema for valid artifact type */
export const ArtifactTypeSchema = z.literal("file");

/** Shared request schemas for REST and MCP */

// Single unified schema for all artifact types (uses input schemas)
// For file artifacts, mimeType will be auto-detected by storage layer
export const CreateArtifactSchema = z.object({
  data: ArtifactDataInputSchema,
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(5000),
  workspaceId: z.string().optional(),
  chatId: z.string().optional(),
  slug: SlugSchema.optional(),
  source: z.string().optional(),
});

export type CreateArtifactInput = z.infer<typeof CreateArtifactSchema>;

/**
 * Schema for artifact updates. Creates a new revision.
 * `slug` and `source` are immutable after creation — carried forward
 * from the previous revision automatically by the storage adapter.
 */
export const UpdateArtifactSchema = z.object({
  type: ArtifactTypeSchema,
  data: ArtifactDataInputSchema,
  title: z.string().min(1).max(200).optional(),
  summary: z.string().min(1).max(5000),
  revisionMessage: z.string().optional(),
});

/** Artifact entity (immutable - updates create revisions) */
export const ArtifactSchema = z.object({
  id: z.string(),
  type: ArtifactTypeSchema,
  revision: z.number(),
  data: ArtifactDataSchema,
  title: z.string(),
  summary: z.string(),
  createdAt: z.iso.datetime(),
  workspaceId: z.string().optional(),
  chatId: z.string().optional(),
  revisionMessage: z.string().optional(),
  slug: SlugSchema.optional(),
  source: z.string().optional(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;

/** Lightweight artifact without blob data — used for list endpoints. */
export const ArtifactSummarySchema = ArtifactSchema.omit({ data: true });
export type ArtifactSummary = z.infer<typeof ArtifactSummarySchema>;

/**
 * Artifact with optional contents loaded.
 * Used when artifact file contents have been fetched alongside metadata.
 */
export type ArtifactWithContents = Artifact & { contents?: string };

/** Lightweight index entry for resource discovery within a workspace. */
export const ResourceIndexEntrySchema = z.object({
  slug: z.string(),
  type: z.string(),
  summary: z.string(),
});
export type ResourceIndexEntry = z.infer<typeof ResourceIndexEntrySchema>;

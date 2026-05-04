import { z } from "zod";
import { FileDataInputSchema, FileDataSchema } from "./primitives.ts";

/** Slug: lowercase alphanumeric + hyphens, with optional path segments separated by `/`. */
const SlugSchema = z.string().regex(/^[a-z0-9-]+(\/[a-z0-9-]+)*$/);

/** Revision summary for history */
export interface ArtifactRevisionSummary {
  revision: number;
  createdAt: string;
  revisionMessage?: string;
}

/**
 * Artifact data envelope (post-redesign 2026-05-02).
 *
 * Was `{ type: "file", version: 1, data: { path, mimeType, originalName? } }`
 * — three layers of `data` wrappers and a `version: 1` literal that
 * was never branched on. Now: `{ type, ...FileData }`. One layer.
 * The `type` discriminator stays so future non-file artifact kinds
 * (URL, structured-doc) can extend the union; the `version` literal
 * is gone (use `Friday-Schema-Version` headers on the JS KV writes
 * for migration routing).
 */
export const ArtifactDataSchema = z.object({ type: z.literal("file"), ...FileDataSchema.shape });

export type ArtifactType = "file";
export type ArtifactData = z.infer<typeof ArtifactDataSchema>;

export const ArtifactDataInputSchema = z.object({
  type: z.literal("file"),
  ...FileDataInputSchema.shape,
});

export type ArtifactDataInput = z.infer<typeof ArtifactDataInputSchema>;

/** Schema for valid artifact type */
export const ArtifactTypeSchema = z.literal("file");

/** Shared request schemas for REST and MCP */

/**
 * Single unified create-artifact request shape. Caller provides the
 * blob content directly (no filesystem path). Storage hashes,
 * sniffs the mime, writes to Object Store + KV.
 */
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
 * Update an artifact's content + metadata. Creates a new revision.
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

/** Artifact entity (immutable; updates create new revisions). */
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

/** Lightweight artifact without blob payload — used for list endpoints. */
export const ArtifactSummarySchema = ArtifactSchema.omit({ data: true }).extend({
  /** Just the metadata fields needed to render a card without a blob fetch. */
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  originalName: z.string().optional(),
});
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

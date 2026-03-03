import { z } from "zod";

/** HTTP status codes used by adapter-layer client errors. Subset of Hono's ContentfulStatusCode. */
export type ClientHttpStatus = 400 | 401 | 403 | 404 | 409 | 422 | 429;

/** Adapter-layer error that should surface as an HTTP 4xx, not 500. */
export class ClientError extends Error {
  constructor(
    message: string,
    public readonly status: ClientHttpStatus = 422,
  ) {
    super(message);
    this.name = "ClientError";
  }
}

/** Discriminant for resource storage behavior. */
export const ResourceTypeSchema = z.enum(["document", "artifact_ref", "external_ref"]);

/** Catalog entry for a resource. One row per resource in `resource_metadata`. */
export const ResourceMetadataSchema = z.object({
  id: z.string(),
  userId: z.string(),
  workspaceId: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  type: ResourceTypeSchema,
  currentVersion: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ResourceMetadata = z.infer<typeof ResourceMetadataSchema>;

/** A version row. `version = null` is the mutable draft. `version >= 1` is immutable. */
export const ResourceVersionSchema = z.object({
  id: z.string(),
  resourceId: z.string(),
  userId: z.string(),
  version: z.number().int().min(1).nullable(),
  schema: z.unknown(),
  data: z.unknown(),
  dirty: z.boolean(),
  draftVersion: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ResourceVersion = z.infer<typeof ResourceVersionSchema>;

/** Input for creating or upserting a resource via `provision()`. */
export const ProvisionInputSchema = z.object({
  userId: z.string(),
  slug: z
    .string()
    .max(200)
    .regex(
      /^[a-z0-9][a-z0-9_-]*$/,
      "Slug must be lowercase alphanumeric with underscores or hyphens, starting with a letter or digit",
    ),
  name: z.string().max(500),
  description: z.string().max(5000),
  type: ResourceTypeSchema,
  schema: z.unknown(),
});
export type ProvisionInput = z.infer<typeof ProvisionInputSchema>;

/** Result of a read-only `query()` call. */
export const QueryResultSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  rowCount: z.number().int(),
});
export type QueryResult = z.infer<typeof QueryResultSchema>;

/** Result of a `mutate()` call. */
export const MutateResultSchema = z.object({ applied: z.boolean() });
export type MutateResult = z.infer<typeof MutateResultSchema>;

/** Result of `publish()`. New version number, or `null` if draft was clean. */
export const PublishResultSchema = z.object({ version: z.number().int().min(1).nullable() });
export type PublishResult = z.infer<typeof PublishResultSchema>;

/** Resource metadata joined with version data. Returned by `getResource()`. */
export const ResourceWithDataSchema = z.object({
  metadata: ResourceMetadataSchema,
  version: ResourceVersionSchema,
});
export type ResourceWithData = z.infer<typeof ResourceWithDataSchema>;

/** Options for `getResource()`. `published: true` returns latest published version. Default returns draft. */
export const GetResourceOptionsSchema = z.object({ published: z.boolean().optional() });
export type GetResourceOptions = z.infer<typeof GetResourceOptionsSchema>;

/**
 * Workspace-scoped resource storage.
 * Abstracts SQLite (local) vs Postgres (production). Multi-tenant per user.
 */
export interface ResourceStorageAdapter {
  /** Create tables, triggers, indexes, and constraints if they don't exist. Idempotent. */
  init(): Promise<void>;

  /** Teardown. Close connections. */
  destroy(): Promise<void>;

  /** Upsert metadata + draft row, auto-publish as version 1. Idempotent on (workspaceId, slug). */
  provision(
    workspaceId: string,
    metadata: ProvisionInput,
    initialData: unknown,
  ): Promise<ResourceMetadata>;

  /** Read-only query. Resolves slug to draft row, wraps agent SQL in CTE scope. */
  query(
    workspaceId: string,
    slug: string,
    rawSql: string,
    params?: unknown[],
  ): Promise<QueryResult>;

  /** Mutation via SELECT. Agent SELECT computes new data; adapter applies UPDATE to draft, sets dirty. */
  mutate(
    workspaceId: string,
    slug: string,
    rawSql: string,
    params?: unknown[],
  ): Promise<MutateResult>;

  /** Snapshot draft as new immutable version. No-op if draft is not dirty. */
  publish(workspaceId: string, slug: string): Promise<PublishResult>;

  /** Direct version insert bypassing draft. Resets draft to match. Used for file upload replacement. */
  replaceVersion(
    workspaceId: string,
    slug: string,
    data: unknown,
    schema?: unknown,
  ): Promise<ResourceVersion>;

  /** List all non-deleted resources for a workspace. */
  listResources(workspaceId: string): Promise<ResourceMetadata[]>;

  /** Get resource metadata + version data. Draft (agent reads) or published (UI reads). */
  getResource(
    workspaceId: string,
    slug: string,
    opts?: GetResourceOptions,
  ): Promise<ResourceWithData | null>;

  /** Delete a resource and its versions. */
  deleteResource(workspaceId: string, slug: string): Promise<void>;

  /** Insert new version with updated ref data. Only valid for ref types. */
  linkRef(workspaceId: string, slug: string, ref: string): Promise<ResourceVersion>;

  /** Reset draft to latest published version, clear dirty flag. Crash recovery. */
  resetDraft(workspaceId: string, slug: string): Promise<void>;

  /** Publish all dirty drafts for a workspace in a single pass. Returns count of published resources. */
  publishAllDirty(workspaceId: string): Promise<number>;

  /** Returns dialect-specific SQL skill text for agent prompt injection. */
  getSkill(): Promise<string>;
}

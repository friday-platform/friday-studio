import type { Result } from "@atlas/utils";
import type { Artifact, ArtifactDataInput, ArtifactSummary, CreateArtifactInput } from "./model.ts";

/**
 * Adapter interface for artifact storage. Single implementation
 * (`JetStreamArtifactStorageAdapter`, JetStream KV + Object Store).
 * All methods return Result<T, string> for consistent error handling.
 */
export interface ArtifactStorageAdapter {
  // CRUD operations
  /**
   * Create a new artifact with revision 1.
   * Generates a unique ID and initializes the artifact.
   */
  create(input: CreateArtifactInput): Promise<Result<Artifact, string>>;

  /**
   * Update an artifact, creating a new revision.
   * Preserves all previous revisions (immutable history).
   */
  update(input: {
    id: string;
    data: ArtifactDataInput;
    title?: string;
    summary: string;
    revisionMessage?: string;
  }): Promise<Result<Artifact, string>>;

  /**
   * Get an artifact by ID.
   * If revision is not specified, returns the latest revision.
   * Returns null if artifact is deleted or doesn't exist.
   */
  get(input: { id: string; revision?: number }): Promise<Result<Artifact | null, string>>;

  /**
   * Soft delete an artifact.
   * Marks the artifact as deleted but preserves all data.
   * Deleted artifacts are hidden from list/get operations.
   */
  deleteArtifact(input: { id: string }): Promise<Result<void, string>>;

  // Batch and list operations
  /**
   * Get multiple artifacts by IDs (latest revisions only).
   * Missing or deleted artifacts are silently skipped.
   * Has a timeout to prevent cascading delays.
   */
  getManyLatest(input: { ids: string[] }): Promise<Result<Artifact[], string>>;

  /**
   * List all artifacts (latest revisions only).
   * Returns up to `limit` artifacts (default: 100).
   * When `includeData` is false, skips blob downloads and returns metadata only.
   */
  listAll(input: {
    limit?: number;
    includeData?: boolean;
  }): Promise<Result<ArtifactSummary[], string>>;

  /**
   * List artifacts by workspace ID (latest revisions only).
   * Returns artifacts associated with the specified workspace.
   * When `includeData` is false, skips blob downloads and returns metadata only.
   */
  listByWorkspace(input: {
    workspaceId: string;
    limit?: number;
    includeData?: boolean;
  }): Promise<Result<ArtifactSummary[], string>>;

  /**
   * List artifacts by chat ID (latest revisions only).
   * Returns artifacts associated with the specified chat session.
   * When `includeData` is false, skips blob downloads and returns metadata only.
   */
  listByChat(input: {
    chatId: string;
    limit?: number;
    includeData?: boolean;
  }): Promise<Result<ArtifactSummary[], string>>;

  // File operations
  /**
   * Read file contents for file-type artifacts.
   * Only supports text-based files (JSON, CSV).
   * Returns raw file contents as a string.
   */
  readFileContents(input: { id: string; revision?: number }): Promise<Result<string, string>>;

  /**
   * Read binary contents for file-type artifacts.
   * Returns raw bytes for any file artifact regardless of MIME type.
   * Used for image support and binary content endpoints.
   */
  readBinaryContents(input: { id: string; revision?: number }): Promise<Result<Uint8Array, string>>;
}

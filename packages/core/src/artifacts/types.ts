import type { Result } from "@atlas/utils";
import type { Artifact, ArtifactDataInput, CreateArtifactInput } from "./model.ts";

/**
 * Options for reading database artifact preview.
 */
export interface ReadDatabasePreviewOptions {
  /** Artifact ID */
  id: string;
  /** Specific revision (defaults to latest) */
  revision?: number;
  /** Maximum rows to return (default: 1000) */
  maxRows?: number;
}

/**
 * Preview data for database artifacts.
 * Used for UI display without loading full dataset.
 */
export interface DatabasePreview {
  /** Column names in order */
  headers: string[];
  /** Row data as key-value records */
  rows: Record<string, unknown>[];
  /** Total number of rows in the database */
  totalRows: number;
  /** True if totalRows > returned rows */
  truncated: boolean;
  /** True if file too large for preview (Cortex only, always false for local) */
  tooLargeForPreview?: boolean;
}

/**
 * Adapter interface for artifact storage backends.
 *
 * Implementations:
 * - LocalStorageAdapter: Deno KV (SQLite-backed) storage
 * - CortexStorageAdapter: Remote blob storage with HTTP API
 *
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
   */
  listAll(input: { limit?: number }): Promise<Result<Artifact[], string>>;

  /**
   * List artifacts by workspace ID (latest revisions only).
   * Returns artifacts associated with the specified workspace.
   */
  listByWorkspace(input: {
    workspaceId: string;
    limit?: number;
  }): Promise<Result<Artifact[], string>>;

  /**
   * List artifacts by chat ID (latest revisions only).
   * Returns artifacts associated with the specified chat session.
   */
  listByChat(input: { chatId: string; limit?: number }): Promise<Result<Artifact[], string>>;

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

  /**
   * Read database preview for database-type artifacts.
   * Returns first N rows with schema information.
   *
   * Opens SQLite file in readonly mode, queries with LIMIT,
   * and closes connection after read.
   */
  readDatabasePreview(input: ReadDatabasePreviewOptions): Promise<Result<DatabasePreview, string>>;

  /**
   * Download database file to a local path for direct access.
   *
   * For LocalStorageAdapter: Returns the existing local path (no download).
   * For CortexStorageAdapter: Downloads to temp directory.
   *
   * Caller is responsible for cleanup when isTemporary is true.
   */
  downloadDatabaseFile(input: {
    id: string;
    revision?: number;
    /** Output directory for downloaded file (required for Cortex, ignored for local) */
    outputDir?: string;
  }): Promise<
    Result<
      {
        /** Path to the database file */
        path: string;
        /** True if file is temporary and should be cleaned up by caller */
        isTemporary: boolean;
      },
      string
    >
  >;
}

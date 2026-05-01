import { unlink } from "node:fs/promises";
import { basename, extname } from "node:path";
import process from "node:process";
import { createLogger } from "@atlas/logger";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { deadline } from "@std/async";
import { decodeBase64 } from "@std/encoding/base64";
import { typeByExtension } from "@std/media-types";
import type {
  Artifact,
  ArtifactData,
  ArtifactDataInput,
  ArtifactSummary,
  CreateArtifactInput,
} from "./model.ts";
import { ArtifactDataSchema, ArtifactSummarySchema, ArtifactTypeSchema } from "./model.ts";
import type { ArtifactStorageAdapter } from "./types.ts";

const logger = createLogger({ name: "cortex-artifact-storage" });
const DEFAULT_TIMEOUT_MS = 10_000; // 10 seconds
const BASE64_PREFIX = new Uint8Array([98, 97, 115, 101, 54, 52, 58]); // "base64:"

function hasBase64Prefix(bytes: Uint8Array): boolean {
  if (bytes.length < BASE64_PREFIX.length) return false;
  for (let i = 0; i < BASE64_PREFIX.length; i++) {
    if (bytes[i] !== BASE64_PREFIX[i]) return false;
  }
  return true;
}

/**
 * Detect MIME type from file path
 */
function detectMimeType(filePath: string): string {
  const ext = extname(filePath);
  const detected = typeByExtension(ext);
  return detected || "application/octet-stream";
}

/**
 * Cortex object metadata structure.
 * Stored in the JSONB metadata field of cortex.object table.
 */
interface CortexMetadata {
  artifact_id: string;
  revision: number;
  artifact_type: string;
  title: string;
  summary: string;
  workspace_id?: string;
  chat_id?: string;
  is_latest: boolean;
  created_at: string;
  revision_message?: string;
  slug?: string;
  source?: string;
}

/**
 * Cortex API response for object listings.
 */
interface CortexObject {
  id: string;
  user_id: string;
  content_size: number | null;
  metadata: CortexMetadata;
  created_at: string;
  updated_at: string;
}

/**
 * Cortex API response for object creation.
 */
interface CreateObjectResponse {
  id: string;
}

/**
 * Remote storage adapter using Cortex blob storage service.
 *
 * Features:
 * - HTTP-based remote storage
 * - Revision simulation (one Cortex object per artifact revision)
 * - Metadata filtering via Cortex API extensions
 * - JWT authentication
 * - Request timeouts and error handling
 *
 * Limitations:
 * - No atomic multi-object updates
 * - N+1 queries for batch operations
 * - Requires Cortex service with metadata filtering support
 */
export class CortexStorageAdapter implements ArtifactStorageAdapter {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/+$/, "") : ""; // Remove trailing slashes
  }

  /**
   * Get FRIDAY_KEY from environment for Cortex authentication.
   */
  private getAuthToken(): string {
    const token = process.env.FRIDAY_KEY;
    if (!token) {
      throw new Error("FRIDAY_KEY not available for Cortex authentication");
    }
    return token;
  }

  /**
   * Generic HTTP request with timeout and authentication.
   * Handles common error cases and response parsing.
   * Strings are sent as-is, objects are JSON.stringify'd, ReadableStreams sent raw.
   */
  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    options?: {
      parseJson?: boolean;
      rawBytes?: boolean;
      streamResponse?: boolean;
      timeoutMs?: number;
    },
  ): Promise<T> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : undefined;

    const isStream = body instanceof ReadableStream;

    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.getAuthToken()}` };

      if (isStream) {
        headers["Content-Type"] = "application/octet-stream";
      } else {
        headers["Content-Type"] = "application/json";
      }

      const fetchOptions: RequestInit & { duplex?: string } = {
        method,
        headers,
        body: isStream
          ? (body as ReadableStream)
          : body
            ? typeof body === "string"
              ? body
              : JSON.stringify(body)
            : undefined,
        signal: controller.signal,
      };

      // Required for streaming request bodies with fetch
      if (isStream) {
        fetchOptions.duplex = "half";
      }

      const response = await fetch(`${this.baseUrl}${endpoint}`, fetchOptions);

      if (response.status === 401) {
        await response.text();
        throw new Error("Authentication failed: invalid FRIDAY_KEY");
      }
      if (response.status === 503) {
        await response.text();
        throw new Error("Cortex service unavailable");
      }
      if (!response.ok && response.status !== 404) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      if (response.status === 404) {
        await response.text();
        return null as T;
      }

      if (options?.streamResponse) {
        return response as unknown as T;
      }

      if (options?.parseJson) {
        return (await response.json()) as T;
      } else if (options?.rawBytes) {
        const buf = await response.arrayBuffer();
        return new Uint8Array(buf) as T;
      } else {
        return (await response.text()) as T;
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request timeout after ${(timeoutMs / 1000).toFixed(1)}s`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Download a blob from Cortex as raw bytes.
   * Handles both old (base64-prefixed text) and new (raw binary) uploads.
   */
  private async downloadBinaryBlob(cortexId: string): Promise<Uint8Array | null> {
    // Try raw bytes first — this is the new upload format
    const bytes = await this.request<Uint8Array>("GET", `/objects/${cortexId}`, undefined, {
      rawBytes: true,
    });
    if (!bytes || bytes.length === 0) {
      return null;
    }

    // Check for old base64-prefixed format: "base64:"
    if (hasBase64Prefix(bytes)) {
      const base64Data = new TextDecoder().decode(bytes.subarray(7));
      return decodeBase64(base64Data);
    }

    return bytes;
  }

  /**
   * Upload binary file to Cortex and return the cortex ID.
   * Handles both text and binary files with base64 encoding.
   * Used by both file and database artifact uploads.
   *
   * @returns Object containing cortexId for the uploaded content
   */
  private async uploadBinaryFile(
    localPath: string,
  ): Promise<Result<{ cortexId: string; mimeType: string }, string>> {
    try {
      // 1. Validate file exists
      let fileInfo: Deno.FileInfo;
      try {
        fileInfo = await Deno.stat(localPath);
      } catch (error) {
        return fail(`File not found: ${localPath} (${stringifyError(error)})`);
      }

      if (!fileInfo.isFile) {
        return fail(`Path is not a file: ${localPath}`);
      }

      // 2. Detect MIME type
      const mimeType = detectMimeType(localPath);

      // 3. Stream file directly to Cortex (no base64, no buffering)
      let file: Deno.FsFile;
      try {
        file = await Deno.open(localPath, { read: true });
      } catch (error) {
        return fail(`Failed to open file: ${localPath} (${stringifyError(error)})`);
      }

      // Scale timeout: 2s per MB, minimum 60s
      const fileSize = fileInfo.size;
      const timeoutMs = Math.max(60_000, (fileSize / (1024 * 1024)) * 2000);

      // 4. Upload file as octet-stream (streamed via ReadableStream)
      // Note: file.readable auto-closes the file resource when the stream is fully consumed.
      // We only call file.close() on error to clean up if the stream was never (fully) consumed.
      let fileUploadResponse: CreateObjectResponse;
      try {
        fileUploadResponse = await this.request<CreateObjectResponse>(
          "POST",
          "/objects",
          file.readable,
          { parseJson: true, timeoutMs },
        );
      } catch (error) {
        try {
          file.close();
        } catch (closeErr) {
          logger.debug("file.close() after stream error — resource already closed", {
            error: stringifyError(closeErr),
          });
        }
        throw error;
      }

      if (!fileUploadResponse?.id) {
        return fail("Failed to upload file to Cortex: no ID returned");
      }

      const fileContentCortexId = fileUploadResponse.id;

      return success({ cortexId: fileContentCortexId, mimeType });
    } catch (error) {
      return fail(`Binary file upload failed: ${stringifyError(error)}`);
    }
  }

  /**
   * Upload file artifact to Cortex.
   * Uploads the binary file and creates the artifact data blob.
   *
   * @returns Object containing cortexId and artifactData for the uploaded file
   */
  private async uploadFileArtifact(
    localPath: string,
  ): Promise<Result<{ cortexId: string; artifactData: ArtifactData }, string>> {
    // 1. Upload the binary file
    const uploadResult = await this.uploadBinaryFile(localPath);
    if (!uploadResult.ok) {
      return fail(uploadResult.error);
    }

    const { cortexId: fileContentCortexId, mimeType } = uploadResult.data;

    // 2. Create artifact data with cortex:// reference
    const artifactData: ArtifactData = {
      type: "file",
      version: 1,
      data: {
        path: `cortex://${fileContentCortexId}`,
        mimeType,
        // Store original filename for downloads
        originalName: basename(localPath),
      },
    };

    // 3. Upload artifact data as second blob (so get() can retrieve it like non-file artifacts)
    const artifactDataJson = JSON.stringify(artifactData);
    const artifactDataUploadResponse = await this.request<CreateObjectResponse>(
      "POST",
      "/objects",
      artifactDataJson,
      { parseJson: true },
    );

    if (!artifactDataUploadResponse?.id) {
      return fail("Failed to upload artifact data to Cortex: no ID returned");
    }

    return success({ cortexId: artifactDataUploadResponse.id, artifactData });
  }

  /** Create artifact with initial revision 1 */
  async create(input: CreateArtifactInput): Promise<Result<Artifact, string>> {
    try {
      const artifactId = crypto.randomUUID();
      const revision = 1;

      const uploadResult = await this.uploadFileArtifact(input.data.data.path);
      if (!uploadResult.ok) {
        return fail(uploadResult.error);
      }
      const { cortexId, artifactData } = uploadResult.data;

      // 2. Set metadata
      const metadata: CortexMetadata = {
        artifact_id: artifactId,
        revision,
        artifact_type: artifactData.type,
        title: input.title,
        summary: input.summary,
        workspace_id: input.workspaceId,
        chat_id: input.chatId,
        is_latest: true,
        created_at: new Date().toISOString(),
        slug: input.slug,
        source: input.source,
      };

      await this.request("POST", `/objects/${cortexId}/metadata`, metadata);

      // 3. Construct artifact response
      const artifact: Artifact = {
        id: artifactId,
        type: artifactData.type,
        revision,
        data: artifactData,
        title: input.title,
        summary: input.summary,
        workspaceId: input.workspaceId,
        chatId: input.chatId,
        createdAt: metadata.created_at,
        slug: input.slug,
        source: input.source,
      };

      // 4. Clean up local file — binary is now in Cortex, local copy is dead weight
      unlink(input.data.data.path).catch(() => {});

      return success(artifact);
    } catch (error) {
      logger.error("Failed to create artifact", { error: stringifyError(error) });
      return fail(`Failed to create artifact: ${stringifyError(error)}`);
    }
  }

  /** Create new revision (preserves history) */
  async update(input: {
    id: string;
    data: ArtifactDataInput;
    title?: string;
    summary: string;
    revisionMessage?: string;
  }): Promise<Result<Artifact, string>> {
    try {
      // 1. Get current latest revision
      const queryUrl =
        `/objects?` +
        new URLSearchParams({ "metadata.artifact_id": input.id, "metadata.is_latest": "true" });

      const currentObjects = await this.request<CortexObject[]>("GET", queryUrl, undefined, {
        parseJson: true,
      });

      if (!currentObjects || currentObjects.length === 0) {
        return fail(`Artifact ${input.id} not found`);
      }

      // biome-ignore lint/style/noNonNullAssertion: length check above guarantees [0] exists
      const currentObject = currentObjects[0]!;
      const currentRevision = currentObject.metadata.revision;

      // 2. Upload new blob (with proper file handling)
      const updateUploadResult = await this.uploadFileArtifact(input.data.data.path);
      if (!updateUploadResult.ok) {
        return fail(updateUploadResult.error);
      }
      const { cortexId: newCortexId, artifactData } = updateUploadResult.data;

      // 3. Set new object metadata with is_latest=FALSE first
      // This ensures the new object is queryable by artifact_id even before we complete the swap
      const newMetadata: CortexMetadata = {
        artifact_id: input.id,
        revision: currentRevision + 1,
        artifact_type: artifactData.type,
        title: input.title ?? currentObject.metadata.title,
        summary: input.summary,
        workspace_id: currentObject.metadata.workspace_id,
        chat_id: currentObject.metadata.chat_id,
        is_latest: false, // NOT latest yet - will be updated in step 5
        created_at: new Date().toISOString(),
        revision_message: input.revisionMessage,
        slug: currentObject.metadata.slug, // immutable after creation
        source: currentObject.metadata.source, // immutable after creation
      };

      try {
        await this.request("POST", `/objects/${newCortexId}/metadata`, newMetadata);
      } catch (error) {
        logger.error("Failed to set new object metadata", {
          newCortexId,
          error: stringifyError(error),
        });
        // New object has metadata but isn't marked latest - no rollback needed
        return fail(`Failed to set new revision metadata: ${stringifyError(error)}`);
      }

      // 4. Mark old object as no longer latest
      // This prepares for the final swap without violating UNIQUE constraint
      const oldMetadata: CortexMetadata = { ...currentObject.metadata, is_latest: false };
      try {
        await this.request("POST", `/objects/${currentObject.id}/metadata`, oldMetadata);
      } catch (error) {
        logger.error("Failed to mark old revision as non-latest", {
          oldCortexId: currentObject.id,
          error: stringifyError(error),
        });
        // Both old and new are now is_latest=false
        // Need to mark new as true in rollback
        try {
          const promoteMetadata: CortexMetadata = { ...newMetadata, is_latest: true };
          await this.request("POST", `/objects/${newCortexId}/metadata`, promoteMetadata);
          logger.info("Promoted new revision to latest after old update failed", { newCortexId });
          // Continue execution - new revision is now latest
        } catch (promoteError) {
          logger.error("CRITICAL: Failed to promote new revision after old update failed", {
            newCortexId,
            error: stringifyError(promoteError),
          });
          return fail(`Failed to update old revision: ${stringifyError(error)}`);
        }
      }

      // 5. Mark new object as latest (completes the swap)
      // Both objects now have full metadata, only is_latest flag differs
      //
      // Race condition window (steps 4-5): Both objects have is_latest=false (~50-200ms)
      // During this window, queries with is_latest=true return empty, but fallback
      // query by artifact_id + revision DESC (in get() method) returns the new object.
      // This is acceptable and self-healing when this step completes.
      const finalMetadata: CortexMetadata = { ...newMetadata, is_latest: true };
      try {
        await this.request("POST", `/objects/${newCortexId}/metadata`, finalMetadata);
      } catch (error) {
        // Critical: new object has metadata but isn't marked latest
        // Try to restore old object as latest
        logger.error("Failed to mark new revision as latest, attempting rollback", {
          newCortexId,
          error: stringifyError(error),
        });

        try {
          const restoreMetadata: CortexMetadata = { ...currentObject.metadata, is_latest: true };
          await this.request("POST", `/objects/${currentObject.id}/metadata`, restoreMetadata);
          logger.info("Successfully rolled back to old revision", {
            oldCortexId: currentObject.id,
          });
        } catch (rollbackError) {
          logger.error("CRITICAL: Failed to rollback to old revision", {
            oldCortexId: currentObject.id,
            error: stringifyError(rollbackError),
          });
          // Artifact is now in inconsistent state - no revision marked as latest
          // Both revisions exist with full metadata but both have is_latest=false
        }

        return fail(`Failed to mark new revision as latest: ${stringifyError(error)}`);
      }

      // 6. Construct response
      const artifact: Artifact = {
        id: input.id,
        type: artifactData.type,
        revision: newMetadata.revision,
        data: artifactData,
        title: newMetadata.title,
        summary: newMetadata.summary,
        workspaceId: newMetadata.workspace_id,
        chatId: newMetadata.chat_id,
        createdAt: newMetadata.created_at,
        revisionMessage: newMetadata.revision_message,
      };

      // Clean up local file — binary is now in Cortex, local copy is dead weight
      unlink(input.data.data.path).catch(() => {});

      return success(artifact);
    } catch (error) {
      logger.error("Failed to update artifact", {
        artifactId: input.id,
        error: stringifyError(error),
      });
      return fail(`Failed to update artifact: ${stringifyError(error)}`);
    }
  }

  /** Get artifact by ID (defaults to latest revision) */
  async get(input: { id: string; revision?: number }): Promise<Result<Artifact | null, string>> {
    try {
      // Build query
      const params: Record<string, string> = { "metadata.artifact_id": input.id };
      if (input.revision) {
        params["metadata.revision"] = String(input.revision);
      } else {
        params["metadata.is_latest"] = "true";
      }

      const queryUrl = `/objects?${new URLSearchParams(params)}`;
      let objects = await this.request<CortexObject[]>("GET", queryUrl, undefined, {
        parseJson: true,
      });

      // Race condition fallback: During update steps 4-5, both objects have is_latest=false
      // If the is_latest=true query returns empty, fall back to querying all revisions
      // and selecting the one with highest revision number
      if ((!objects || objects.length === 0) && !input.revision) {
        logger.debug("is_latest query returned empty, falling back to revision ordering", {
          artifactId: input.id,
        });

        const fallbackUrl = `/objects?${new URLSearchParams({ "metadata.artifact_id": input.id })}`;
        objects = await this.request<CortexObject[]>("GET", fallbackUrl, undefined, {
          parseJson: true,
        });

        if (!objects || objects.length === 0) {
          return success(null);
        }

        // Sort by revision DESC (client-side) to get the latest
        // The SQL query already orders by (created_at DESC, revision DESC), but we sort
        // explicitly by revision to be certain we get the highest revision number
        objects.sort((a, b) => b.metadata.revision - a.metadata.revision);

        logger.debug("Fallback query found artifact during race window", {
          artifactId: input.id,
          revision: objects[0]?.metadata.revision,
        });
      }

      if (!objects || objects.length === 0) {
        return success(null);
      }

      // Take the first object (highest revision during race window, or the is_latest=true object normally)
      // biome-ignore lint/style/noNonNullAssertion: length check above guarantees [0] exists
      const cortexObject = objects[0]!;

      // Download blob and parse artifact data
      const blobContent = await this.request<string>("GET", `/objects/${cortexObject.id}`);
      if (!blobContent) {
        return fail(`Failed to download blob for artifact ${input.id}`);
      }

      // Parse and validate artifact data
      let artifactData: ArtifactData;
      try {
        const parsed = JSON.parse(blobContent);
        const result = ArtifactDataSchema.safeParse(parsed);
        if (!result.success) {
          logger.error("Invalid artifact data schema", {
            artifactId: input.id,
            receivedType: (parsed as Record<string, unknown>)?.type,
            error: result.error.message,
          });
          return fail(`Invalid artifact data: ${result.error.message}`);
        }
        artifactData = result.data;
      } catch (error) {
        return fail(`Failed to parse artifact data: ${stringifyError(error)}`);
      }

      const artifact: Artifact = {
        id: input.id,
        type: ArtifactTypeSchema.parse(cortexObject.metadata.artifact_type),
        revision: cortexObject.metadata.revision,
        data: artifactData,
        title: cortexObject.metadata.title,
        summary: cortexObject.metadata.summary,
        workspaceId: cortexObject.metadata.workspace_id,
        chatId: cortexObject.metadata.chat_id,
        createdAt: cortexObject.metadata.created_at,
        revisionMessage: cortexObject.metadata.revision_message,
        slug: cortexObject.metadata.slug,
        source: cortexObject.metadata.source,
      };

      return success(artifact);
    } catch (error) {
      logger.error("Failed to get artifact", {
        artifactId: input.id,
        error: stringifyError(error),
      });
      return fail(`Failed to get artifact: ${stringifyError(error)}`);
    }
  }

  /**
   * Batch get artifacts by IDs (latest revisions only).
   * Uses parallel requests with timeout.
   */
  async getManyLatest(input: { ids: string[] }): Promise<Result<Artifact[], string>> {
    if (!input.ids || input.ids.length === 0) {
      return success([]);
    }

    const TOTAL_TIMEOUT = 5000; // Match LocalAdapter timeout

    try {
      const result = await deadline(this.doGetManyLatest(input), TOTAL_TIMEOUT);
      return result;
    } catch (error) {
      logger.warn("Artifact batch fetch timed out", {
        requestedCount: input.ids.length,
        error: stringifyError(error),
      });
      return fail(`Artifact batch fetch timed out: ${stringifyError(error)}`);
    }
  }

  /**
   * Internal implementation of getManyLatest without timeout wrapper.
   */
  private async doGetManyLatest(input: { ids: string[] }): Promise<Result<Artifact[], string>> {
    try {
      // Parallel requests for each artifact ID with individual error handling
      const promises = input.ids.map((id) =>
        this.get({ id }).catch((err) => {
          logger.warn("Failed to fetch artifact in batch", {
            artifactId: id,
            error: stringifyError(err),
          });
          // Return success with null to indicate missing artifact
          return success(null);
        }),
      );
      const results = await Promise.all(promises);

      // Filter successful results
      const artifacts: Artifact[] = [];
      for (const result of results) {
        if (result.ok && result.data !== null) {
          artifacts.push(result.data);
        }
      }

      // Log if some artifacts failed
      if (artifacts.length < input.ids.length) {
        logger.warn("Some artifacts failed in batch fetch", {
          requested: input.ids.length,
          succeeded: artifacts.length,
          failed: input.ids.length - artifacts.length,
        });
      }

      return success(artifacts);
    } catch (error) {
      return fail(`Batch fetch failed: ${stringifyError(error)}`);
    }
  }

  /** List workspace artifacts (latest revisions only) */
  async listByWorkspace(input: {
    workspaceId: string;
    limit?: number;
    includeData?: boolean;
  }): Promise<Result<ArtifactSummary[], string>> {
    return await this.listFiltered(
      { workspace_id: input.workspaceId, is_latest: "true" },
      input.limit,
      input.includeData,
    );
  }

  /** List chat artifacts (latest revisions only) */
  async listByChat(input: {
    chatId: string;
    limit?: number;
    includeData?: boolean;
  }): Promise<Result<ArtifactSummary[], string>> {
    return await this.listFiltered(
      { chat_id: input.chatId, is_latest: "true" },
      input.limit,
      input.includeData,
    );
  }

  /** List all artifacts (latest revisions only) */
  async listAll(input: {
    limit?: number;
    includeData?: boolean;
  }): Promise<Result<ArtifactSummary[], string>> {
    return await this.listFiltered({ is_latest: "true" }, input.limit, input.includeData);
  }

  /**
   * Generic list implementation with metadata filtering.
   *
   * Handles the update race window (steps 4-5 of update flow) where both old and new
   * revisions temporarily have is_latest=false. When the is_latest=true query misses
   * artifacts, a fallback query without is_latest finds them. Results are deduplicated
   * by artifact_id, keeping the highest revision per artifact.
   *
   * When `includeData` is false (default true), skips blob downloads entirely and
   * constructs artifacts from Cortex metadata alone — dramatically reducing payload
   * size and latency for list views that only need id/type/title/createdAt.
   */
  private async listFiltered(
    filters: Record<string, string>,
    limit?: number,
    includeData?: boolean,
  ): Promise<Result<ArtifactSummary[], string>> {
    const shouldIncludeData = includeData !== false;

    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        params.set(`metadata.${key}`, value);
      }
      if (limit) {
        params.set("limit", String(limit));
      }

      const queryUrl = `/objects?${params.toString()}`;
      let objects = await this.request<CortexObject[]>("GET", queryUrl, undefined, {
        parseJson: true,
      });

      if (!objects) {
        objects = [];
      }

      // Race condition fallback: During update steps 4-5, both old and new revisions
      // have is_latest=false. Query without is_latest to find artifacts invisible
      // to the primary query. Only runs when the primary query returned nothing.
      // Note: this only covers the case where ALL results are hidden (e.g. a single
      // artifact mid-update). If N artifacts exist and 1 is mid-update, the primary
      // query returns N-1 and the fallback does not fire — that partial absence is
      // an accepted trade-off for the read path.
      const hasIsLatestFilter = "is_latest" in filters;
      if (hasIsLatestFilter && objects.length === 0) {
        try {
          const fallbackParams = new URLSearchParams();
          for (const [key, value] of Object.entries(filters)) {
            if (key !== "is_latest") {
              fallbackParams.set(`metadata.${key}`, value);
            }
          }
          if (limit) {
            fallbackParams.set("limit", String(limit));
          }

          const fallbackUrl = `/objects?${fallbackParams.toString()}`;
          const fallbackObjects = await this.request<CortexObject[]>(
            "GET",
            fallbackUrl,
            undefined,
            { parseJson: true },
          );

          if (fallbackObjects && fallbackObjects.length > 0) {
            // Pick highest revision per artifact
            const byArtifact = new Map<string, CortexObject>();
            for (const obj of fallbackObjects) {
              const aid = obj.metadata.artifact_id;
              const existing = byArtifact.get(aid);
              if (!existing || obj.metadata.revision > existing.metadata.revision) {
                byArtifact.set(aid, obj);
              }
            }

            logger.debug("List fallback found artifacts during race window", {
              fallbackCount: byArtifact.size,
            });
            objects = [...byArtifact.values()];
          }
        } catch (fallbackError) {
          // Fallback is best-effort — return empty rather than failing the whole list
          logger.warn("List race-condition fallback failed, returning empty results", {
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          });
        }
      }

      if (objects.length === 0) {
        return success([]);
      }

      // When includeData is false, construct artifacts from metadata only — no blob downloads.
      // Validated via ArtifactSummarySchema.safeParse — malformed metadata (e.g. non-ISO
      // created_at from legacy data) is logged and skipped rather than returned unvalidated.
      // created_at is always set via new Date().toISOString() in create/update, so failures
      // here indicate data written by an older code path or manual Cortex insertion.
      if (!shouldIncludeData) {
        const summaries: ArtifactSummary[] = [];
        for (const obj of objects) {
          const result = ArtifactSummarySchema.safeParse({
            id: obj.metadata.artifact_id,
            type: obj.metadata.artifact_type,
            revision: obj.metadata.revision,
            title: obj.metadata.title,
            summary: obj.metadata.summary,
            workspaceId: obj.metadata.workspace_id,
            chatId: obj.metadata.chat_id,
            createdAt: obj.metadata.created_at,
            revisionMessage: obj.metadata.revision_message,
            slug: obj.metadata.slug,
            source: obj.metadata.source,
          });
          if (result.success) {
            summaries.push(result.data);
          } else {
            logger.warn("Failed to validate artifact summary from metadata", {
              cortexId: obj.id,
              artifactId: obj.metadata.artifact_id,
              error: result.error.message,
            });
          }
        }
        if (summaries.length < objects.length) {
          logger.warn("Some artifacts dropped during metadata-only list", {
            total: objects.length,
            valid: summaries.length,
            dropped: objects.length - summaries.length,
          });
        }
        return success(summaries);
      }

      // Download blobs and reconstruct artifacts in parallel
      const artifacts = await Promise.all(
        objects.map(async (obj) => {
          try {
            const blobContent = await this.request<string>("GET", `/objects/${obj.id}`);
            if (!blobContent) {
              logger.warn("Failed to download blob", { cortexId: obj.id });
              return null;
            }

            // Parse and validate artifact data
            let artifactData: ArtifactData;
            try {
              const parsed: unknown = JSON.parse(blobContent);
              const result = ArtifactDataSchema.safeParse(parsed);
              if (!result.success) {
                logger.warn("Invalid artifact data schema in list", {
                  cortexId: obj.id,
                  artifactId: obj.metadata.artifact_id,
                  receivedType: (parsed as Record<string, unknown>)?.type,
                  error: result.error.message,
                });
                return null;
              }
              artifactData = result.data;
            } catch (error) {
              logger.warn("Failed to parse artifact data in list", {
                cortexId: obj.id,
                error: stringifyError(error),
              });
              return null;
            }

            const typeResult = ArtifactTypeSchema.safeParse(obj.metadata.artifact_type);
            if (!typeResult.success) {
              logger.warn("Invalid artifact type in list", {
                cortexId: obj.id,
                artifactId: obj.metadata.artifact_id,
                artifactType: obj.metadata.artifact_type,
              });
              return null;
            }

            const artifact: Artifact = {
              id: obj.metadata.artifact_id,
              type: typeResult.data,
              revision: obj.metadata.revision,
              data: artifactData,
              title: obj.metadata.title,
              summary: obj.metadata.summary,
              workspaceId: obj.metadata.workspace_id,
              chatId: obj.metadata.chat_id,
              createdAt: obj.metadata.created_at,
              revisionMessage: obj.metadata.revision_message,
              slug: obj.metadata.slug,
              source: obj.metadata.source,
            };

            return artifact;
          } catch (error) {
            logger.warn("Failed to reconstruct artifact", {
              cortexId: obj.id,
              error: stringifyError(error),
            });
            return null;
          }
        }),
      );

      // Filter out failed reconstructions
      const validArtifacts = artifacts.filter((a): a is Artifact => a !== null);

      // Warn if some artifacts failed to load
      if (validArtifacts.length < objects.length) {
        logger.warn("Some artifacts failed to load in list operation", {
          requested: objects.length,
          succeeded: validArtifacts.length,
          failed: objects.length - validArtifacts.length,
        });
      }

      return success(validArtifacts);
    } catch (error) {
      logger.error("Failed to list artifacts", { filters, error: stringifyError(error) });
      return fail(`Failed to list artifacts: ${stringifyError(error)}`);
    }
  }

  /** Soft delete artifact (all revisions) */
  async deleteArtifact(input: { id: string }): Promise<Result<void, string>> {
    try {
      // Get all revisions for this artifact
      const queryUrl = `/objects?${new URLSearchParams({ "metadata.artifact_id": input.id })}`;

      const objects = await this.request<CortexObject[]>("GET", queryUrl, undefined, {
        parseJson: true,
      });

      if (!objects || objects.length === 0) {
        return fail(`Artifact ${input.id} not found`);
      }

      // Soft delete all revisions (Cortex sets deleted_at)
      await Promise.all(objects.map((obj) => this.request("DELETE", `/objects/${obj.id}`)));

      return success(undefined);
    } catch (error) {
      logger.error("Failed to delete artifact", {
        artifactId: input.id,
        error: stringifyError(error),
      });
      return fail(`Failed to delete artifact: ${stringifyError(error)}`);
    }
  }

  /**
   * Read file contents for file-type artifacts.
   * For Cortex, file artifacts have path="cortex://{cortex_id}".
   * Handles base64-encoded binary files.
   */
  async readFileContents(input: {
    id: string;
    revision?: number;
  }): Promise<Result<string, string>> {
    try {
      const artifactResult = await this.get(input);
      if (!artifactResult.ok) {
        return fail(artifactResult.error);
      }

      const artifact = artifactResult.data;
      if (!artifact) {
        return fail(`Artifact ${input.id} not found`);
      }

      if (artifact.data.type !== "file") {
        return fail(`Artifact ${input.id} is not a file artifact`);
      }

      // For Cortex, artifact.data.data.path is cortex://{cortex_id}
      // Extract cortex_id and download blob
      const path = artifact.data.data.path;
      if (!path.startsWith("cortex://")) {
        return fail(`Invalid Cortex path: ${path}`);
      }

      const cortexId = path.replace("cortex://", "");

      // Download as raw bytes to handle both old (base64-prefixed) and new (raw binary) uploads
      const bytes = await this.downloadBinaryBlob(cortexId);
      if (!bytes) {
        return fail(`Failed to download file contents from Cortex`);
      }

      const decoder = new TextDecoder();
      return success(decoder.decode(bytes));
    } catch (error) {
      logger.error("Failed to read file contents", {
        artifactId: input.id,
        error: stringifyError(error),
      });
      return fail(`Failed to read file: ${stringifyError(error)}`);
    }
  }

  /**
   * Read binary contents for a file artifact.
   * Delegates to downloadBinaryBlob for the raw bytes.
   */
  async readBinaryContents(input: {
    id: string;
    revision?: number;
  }): Promise<Result<Uint8Array, string>> {
    try {
      const artifactResult = await this.get(input);
      if (!artifactResult.ok) {
        return fail(artifactResult.error);
      }

      const artifact = artifactResult.data;
      if (!artifact) {
        return fail(`Artifact ${input.id} not found`);
      }

      if (artifact.data.type !== "file") {
        return fail(`Artifact ${input.id} is not a file artifact`);
      }

      const path = artifact.data.data.path;
      if (!path.startsWith("cortex://")) {
        return fail(`Invalid Cortex path: ${path}`);
      }

      const cortexId = path.replace("cortex://", "");
      const bytes = await this.downloadBinaryBlob(cortexId);
      if (!bytes) {
        return fail(`Failed to download binary contents from Cortex`);
      }

      return success(bytes);
    } catch (error) {
      logger.error("Failed to read binary contents", {
        artifactId: input.id,
        error: stringifyError(error),
      });
      return fail(`Failed to read file: ${stringifyError(error)}`);
    }
  }
}

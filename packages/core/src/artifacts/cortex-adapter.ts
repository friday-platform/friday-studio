import { createLogger } from "@atlas/logger";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { deadline } from "@std/async";
import { decodeBase64, encodeBase64 } from "@std/encoding/base64";
import { typeByExtension } from "@std/media-types";
import { basename, extname } from "@std/path";
import type { Artifact, ArtifactData, ArtifactDataInput, CreateArtifactInput } from "./model.ts";
import { ArtifactDataSchema } from "./model.ts";
import type { ArtifactStorageAdapter } from "./types.ts";

const logger = createLogger({ name: "cortex-artifact-storage" });
const DEFAULT_TIMEOUT_MS = 10_000; // 10 seconds

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
  private readonly authToken: string;

  constructor(baseUrl: string, authToken: string) {
    // Note: URL validation deferred to first request to allow test setup
    this.baseUrl = baseUrl ? baseUrl.replace(/\/+$/, "") : ""; // Remove trailing slashes
    this.authToken = authToken;
  }

  /**
   * Generic HTTP request with timeout and authentication.
   * Handles common error cases and response parsing.
   */
  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown,
    options?: { parseJson?: boolean },
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.authToken}` },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (response.status === 401) {
        await response.text(); // Consume body to prevent resource leak
        throw new Error("Authentication failed: invalid ATLAS_KEY");
      }
      if (response.status === 503) {
        await response.text(); // Consume body to prevent resource leak
        throw new Error("Cortex service unavailable");
      }
      if (!response.ok && response.status !== 404) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      if (response.status === 404) {
        await response.text(); // Consume body to prevent resource leak
        return null as T;
      }

      if (options?.parseJson) {
        return (await response.json()) as T;
      } else {
        return (await response.text()) as T;
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Request timeout after 10s");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Upload file artifact to Cortex.
   * Handles both text and binary files with base64 encoding.
   *
   * @returns Object containing cortexId and artifactData for the uploaded file
   */
  private async uploadFileArtifact(
    localPath: string,
  ): Promise<Result<{ cortexId: string; artifactData: ArtifactData }, string>> {
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

      // 3. Read file contents (binary safe)
      let fileBytes: Uint8Array;
      try {
        fileBytes = await Deno.readFile(localPath);
      } catch (error) {
        return fail(`Failed to read file: ${localPath} (${stringifyError(error)})`);
      }

      // 4. Encode as base64 for JSON transport if binary
      // Cortex API expects {content: string}, so we base64 encode binary data
      const decoder = new TextDecoder();

      let contentForUpload: string;
      if (mimeType.startsWith("text/") || mimeType === "application/json") {
        // Text files: decode as UTF-8 string
        contentForUpload = decoder.decode(fileBytes);
      } else {
        // Binary files: base64 encode
        // Prefix with marker so Cortex/downloads can detect encoding
        const base64 = encodeBase64(fileBytes);
        contentForUpload = `base64:${base64}`;
      }

      // 5. Upload file content to Cortex (first blob)
      const fileUploadResponse = await this.request<CreateObjectResponse>(
        "POST",
        "/objects",
        { content: contentForUpload },
        { parseJson: true },
      );

      if (!fileUploadResponse || !fileUploadResponse.id) {
        return fail("Failed to upload file to Cortex: no ID returned");
      }

      const fileContentCortexId = fileUploadResponse.id;

      // 6. Create artifact data with cortex:// reference
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

      // 7. Upload artifact data as second blob (so get() can retrieve it like non-file artifacts)
      const artifactDataJson = JSON.stringify(artifactData);
      const artifactDataUploadResponse = await this.request<CreateObjectResponse>(
        "POST",
        "/objects",
        { content: artifactDataJson },
        { parseJson: true },
      );

      if (!artifactDataUploadResponse || !artifactDataUploadResponse.id) {
        return fail("Failed to upload artifact data to Cortex: no ID returned");
      }

      const cortexId = artifactDataUploadResponse.id;

      return success({ cortexId, artifactData });
    } catch (error) {
      return fail(`File upload failed: ${stringifyError(error)}`);
    }
  }

  /** Create artifact with initial revision 1 */
  async create(input: CreateArtifactInput): Promise<Result<Artifact, string>> {
    try {
      const artifactId = crypto.randomUUID();
      const revision = 1;

      let artifactData: ArtifactData;
      let blobContent: string;
      let cortexId: string;

      if (input.data.type === "file") {
        const localPath = input.data.data.path;

        const uploadResult = await this.uploadFileArtifact(localPath);
        if (!uploadResult.ok) {
          return fail(uploadResult.error);
        }

        cortexId = uploadResult.data.cortexId;
        artifactData = uploadResult.data.artifactData;
      } else {
        // Non-file artifacts: serialize as JSON
        artifactData = input.data;
        blobContent = JSON.stringify(artifactData);

        // Upload JSON blob to Cortex
        const uploadResponse = await this.request<CreateObjectResponse>(
          "POST",
          "/objects",
          { content: blobContent },
          { parseJson: true },
        );

        if (!uploadResponse || !uploadResponse.id) {
          return fail("Failed to upload blob to Cortex: no ID returned");
        }

        cortexId = uploadResponse.id;
      }

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
      };

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

      const currentObject = currentObjects[0]!;
      const currentRevision = currentObject.metadata.revision;

      // 2. Upload new blob (with proper file handling)
      let artifactData: ArtifactData;
      let blobContent: string;
      let newCortexId: string;

      if (input.data.type === "file") {
        const localPath = input.data.data.path;

        const uploadResult = await this.uploadFileArtifact(localPath);
        if (!uploadResult.ok) {
          return fail(uploadResult.error);
        }

        newCortexId = uploadResult.data.cortexId;
        artifactData = uploadResult.data.artifactData;
      } else {
        // Non-file artifacts: serialize as JSON
        artifactData = input.data;
        blobContent = JSON.stringify(artifactData);

        // Upload JSON blob to Cortex
        const uploadResponse = await this.request<CreateObjectResponse>(
          "POST",
          "/objects",
          { content: blobContent },
          { parseJson: true },
        );

        if (!uploadResponse || !uploadResponse.id) {
          return fail("Failed to upload new revision blob");
        }

        newCortexId = uploadResponse.id;
      }

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

      const queryUrl = `/objects?` + new URLSearchParams(params);
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

        const fallbackUrl = `/objects?` + new URLSearchParams({ "metadata.artifact_id": input.id });
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
          revision: objects[0]!.metadata.revision,
        });
      }

      if (!objects || objects.length === 0) {
        return success(null);
      }

      // Take the first object (highest revision during race window, or the is_latest=true object normally)
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
        type: cortexObject.metadata.artifact_type as Artifact["type"],
        revision: cortexObject.metadata.revision,
        data: artifactData,
        title: cortexObject.metadata.title,
        summary: cortexObject.metadata.summary,
        workspaceId: cortexObject.metadata.workspace_id,
        chatId: cortexObject.metadata.chat_id,
        createdAt: cortexObject.metadata.created_at,
        revisionMessage: cortexObject.metadata.revision_message,
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
  }): Promise<Result<Artifact[], string>> {
    return await this.listFiltered(
      { workspace_id: input.workspaceId, is_latest: "true" },
      input.limit,
    );
  }

  /** List chat artifacts (latest revisions only) */
  async listByChat(input: { chatId: string; limit?: number }): Promise<Result<Artifact[], string>> {
    return await this.listFiltered({ chat_id: input.chatId, is_latest: "true" }, input.limit);
  }

  /** List all artifacts (latest revisions only) */
  async listAll(input: { limit?: number }): Promise<Result<Artifact[], string>> {
    return await this.listFiltered({ is_latest: "true" }, input.limit);
  }

  /**
   * Generic list implementation with metadata filtering.
   *
   * Note: During artifact updates (steps 4-5 of update flow), artifacts temporarily
   * have is_latest=false on both old and new revisions. During this window (~50-200ms),
   * artifacts being updated will not appear in list results that filter on is_latest=true.
   * This is acceptable for list operations (which are for browsing/discovery).
   * For direct access, use get() which has fallback logic to handle this race condition.
   */
  private async listFiltered(
    filters: Record<string, string>,
    limit?: number,
  ): Promise<Result<Artifact[], string>> {
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        params.set(`metadata.${key}`, value);
      }
      if (limit) {
        params.set("limit", String(limit));
      }

      const queryUrl = `/objects?` + params.toString();
      const objects = await this.request<CortexObject[]>("GET", queryUrl, undefined, {
        parseJson: true,
      });

      if (!objects || objects.length === 0) {
        return success([]);
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
              const parsed = JSON.parse(blobContent);
              const result = ArtifactDataSchema.safeParse(parsed);
              if (!result.success) {
                logger.warn("Invalid artifact data schema in list", {
                  cortexId: obj.id,
                  artifactId: obj.metadata.artifact_id,
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

            const artifact: Artifact = {
              id: obj.metadata.artifact_id,
              type: obj.metadata.artifact_type as Artifact["type"],
              revision: obj.metadata.revision,
              data: artifactData,
              title: obj.metadata.title,
              summary: obj.metadata.summary,
              workspaceId: obj.metadata.workspace_id,
              chatId: obj.metadata.chat_id,
              createdAt: obj.metadata.created_at,
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
      const queryUrl = `/objects?` + new URLSearchParams({ "metadata.artifact_id": input.id });

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
      const contents = await this.request<string>("GET", `/objects/${cortexId}`);

      if (!contents) {
        return fail(`Failed to download file contents from Cortex`);
      }

      // Decode base64 if it was encoded during upload
      if (contents.startsWith("base64:")) {
        const base64Data = contents.slice(7); // Remove "base64:" prefix
        try {
          // Decode base64 to binary, then to UTF-8 string
          const bytes = decodeBase64(base64Data);
          const decoder = new TextDecoder();
          return success(decoder.decode(bytes));
        } catch (error) {
          return fail(`Failed to decode base64 content: ${stringifyError(error)}`);
        }
      }

      return success(contents);
    } catch (error) {
      logger.error("Failed to read file contents", {
        artifactId: input.id,
        error: stringifyError(error),
      });
      return fail(`Failed to read file: ${stringifyError(error)}`);
    }
  }
}

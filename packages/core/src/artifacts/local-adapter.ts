import { readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { createLogger } from "@atlas/logger";
import { fail, type Result, stringifyError, success } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { Database } from "@db/sqlite";
import { deadline } from "@std/async";
import { typeByExtension } from "@std/media-types";
import { openKv } from "../kv.ts";
import type {
  Artifact,
  ArtifactData,
  ArtifactDataInput,
  ArtifactSummary,
  CreateArtifactInput,
} from "./model.ts";
import type {
  ArtifactStorageAdapter,
  DatabasePreview,
  ReadDatabasePreviewOptions,
} from "./types.ts";

/** Strip `data` from an Artifact to produce an ArtifactSummary. */
function toSummary(artifact: Artifact): ArtifactSummary {
  const { data: _data, ...summary } = artifact;
  return summary;
}

const logger = createLogger({ name: "local-artifact-storage" });

type ArtifactKey = ["artifact", string, number];
type LatestKey = ["artifact_latest", string];
type ByWorkspaceKey = ["artifacts_by_workspace", string, string];
type ByChatKey = ["artifacts_by_chat", string, string];
type DeletedKey = ["artifact_deleted", string];

const keys = {
  artifact: (id: string, revision: number): ArtifactKey => ["artifact", id, revision],
  latest: (id: string): LatestKey => ["artifact_latest", id],
  byWorkspace: (workspaceId: string, id: string): ByWorkspaceKey => [
    "artifacts_by_workspace",
    workspaceId,
    id,
  ],
  byChat: (chatId: string, id: string): ByChatKey => ["artifacts_by_chat", chatId, id],
  deleted: (id: string): DeletedKey => ["artifact_deleted", id],
};

/**
 * Detect MIME type from file path
 */
function detectMimeType(filePath: string): string {
  const ext = extname(filePath);
  const detected = typeByExtension(ext);
  return detected || "application/octet-stream";
}

const READABLE_MIME_TYPES = new Set([
  "application/json",
  "text/csv",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/yaml",
]);

/**
 * Local storage adapter using Deno KV (SQLite-backed).
 *
 * Features:
 * - Immutable revisions (updates create new revisions)
 * - Soft delete (data preserved)
 * - Atomic transactions for consistency
 * - Secondary indices for efficient querying
 * - File MIME type auto-detection
 */
export class LocalStorageAdapter implements ArtifactStorageAdapter {
  private readonly kvPath: string;

  constructor(kvPath?: string) {
    this.kvPath = kvPath || join(getAtlasHome(), "storage.db");
  }

  /** Create artifact with initial revision 1 */
  async create(input: CreateArtifactInput): Promise<Result<Artifact, string>> {
    using db = await openKv(this.kvPath);

    // Transform input to output by enriching file artifacts
    let artifactData: ArtifactData;

    if (input.data.type === "file") {
      const fileInput = input.data.data;

      try {
        await stat(fileInput.path);
      } catch (error) {
        return fail(`File not found: ${fileInput.path} (${stringifyError(error)})`);
      }

      const mimeType = detectMimeType(fileInput.path);
      artifactData = {
        type: "file",
        version: 1,
        data: {
          path: fileInput.path,
          mimeType,
          originalName: fileInput.originalName || basename(fileInput.path),
        },
      };
    } else {
      artifactData = input.data;
    }

    const id = crypto.randomUUID();
    const revision = 1;

    const artifact: Artifact = {
      id,
      type: artifactData.type,
      revision,
      data: artifactData,
      title: input.title,
      summary: input.summary,
      workspaceId: input.workspaceId,
      chatId: input.chatId,
      createdAt: new Date().toISOString(),
      ...(input.source ? { source: input.source } : {}),
    };

    const tx = db.atomic();
    const primaryKey = keys.artifact(id, revision);

    tx.set(primaryKey, artifact);
    tx.set(keys.latest(id), revision);

    if (input.workspaceId) {
      tx.set(keys.byWorkspace(input.workspaceId, id), primaryKey);
    }
    if (input.chatId) {
      tx.set(keys.byChat(input.chatId, id), primaryKey);
    }

    try {
      const result = await tx.commit();
      if (!result.ok) {
        return fail("Failed to create artifact");
      }
    } catch (error) {
      // Deno KV has a 64KB limit per value
      if (error instanceof TypeError && error.message.includes("Value too large")) {
        return fail("Artifact data exceeds maximum size (64KB)");
      }
      throw error;
    }

    return success(artifact);
  }

  /** Create new revision (preserves history) */
  async update(input: {
    id: string;
    data: ArtifactDataInput;
    title?: string;
    summary: string;
    revisionMessage?: string;
  }): Promise<Result<Artifact, string>> {
    using db = await openKv(this.kvPath);

    const latestRevisionResult = await db.get<number>(keys.latest(input.id));
    if (!latestRevisionResult.value) {
      return fail(`Artifact ${input.id} not found`);
    }

    const currentRevision = latestRevisionResult.value;

    const deletedResult = await db.get<Date>(keys.deleted(input.id));
    if (deletedResult.value) {
      return fail(`Artifact ${input.id} has been deleted`);
    }

    const currentArtifactResult = await db.get<Artifact>(keys.artifact(input.id, currentRevision));
    if (!currentArtifactResult.value) {
      return fail(`Artifact ${input.id} revision ${currentRevision} not found`);
    }

    const currentArtifact = currentArtifactResult.value;

    // Transform input to output by enriching file artifacts
    let artifactData: ArtifactData;

    if (input.data.type === "file") {
      const fileInput = input.data.data;

      try {
        await stat(fileInput.path);
      } catch (error) {
        return fail(`File not found: ${fileInput.path} (${stringifyError(error)})`);
      }

      const mimeType = detectMimeType(fileInput.path);
      artifactData = {
        type: "file",
        version: 1,
        data: {
          path: fileInput.path,
          mimeType,
          originalName: fileInput.originalName || basename(fileInput.path),
        },
      };
    } else {
      artifactData = input.data;
    }

    const newArtifact: Artifact = {
      id: input.id,
      type: currentArtifact.type,
      revision: currentRevision + 1,
      data: artifactData,
      title: input.title ?? currentArtifact.title,
      summary: input.summary,
      workspaceId: currentArtifact.workspaceId,
      chatId: currentArtifact.chatId,
      createdAt: new Date().toISOString(),
      revisionMessage: input.revisionMessage,
    };

    const tx = db.atomic();
    const newPrimaryKey = keys.artifact(input.id, newArtifact.revision);

    tx.set(newPrimaryKey, newArtifact);
    tx.set(keys.latest(input.id), newArtifact.revision);

    if (newArtifact.workspaceId) {
      tx.set(keys.byWorkspace(newArtifact.workspaceId, input.id), newPrimaryKey);
    }
    if (newArtifact.chatId) {
      tx.set(keys.byChat(newArtifact.chatId, input.id), newPrimaryKey);
    }

    try {
      const result = await tx.commit();
      if (!result.ok) {
        return fail("Failed to update artifact");
      }
    } catch (error) {
      // Deno KV has a 64KB limit per value
      if (error instanceof TypeError && error.message.includes("Value too large")) {
        return fail("Artifact data exceeds maximum size (64KB)");
      }
      throw error;
    }

    return success(newArtifact);
  }

  /** Get artifact by ID (defaults to latest revision) */
  async get(input: { id: string; revision?: number }): Promise<Result<Artifact | null, string>> {
    using db = await openKv(this.kvPath);

    const deletedResult = await db.get<Date>(keys.deleted(input.id));
    if (deletedResult.value) {
      return success(null);
    }

    let targetRevision = input.revision;
    if (!targetRevision) {
      const latestRevisionResult = await db.get<number>(keys.latest(input.id));
      if (!latestRevisionResult.value) {
        return success(null);
      }
      targetRevision = latestRevisionResult.value;
    }

    const artifactResult = await db.get<Artifact>(keys.artifact(input.id, targetRevision));
    return success(artifactResult.value || null);
  }

  /** List workspace artifacts (latest revisions only) */
  async listByWorkspace(input: {
    workspaceId: string;
    limit?: number;
    includeData?: boolean;
  }): Promise<Result<ArtifactSummary[], string>> {
    using db = await openKv(this.kvPath);

    const artifacts: Artifact[] = [];
    const limit = input.limit ?? 100;

    const entries = db.list<ArtifactKey>({ prefix: ["artifacts_by_workspace", input.workspaceId] });

    for await (const entry of entries) {
      const [, id] = entry.value;

      const deletedResult = await db.get<Date>(keys.deleted(id));
      if (deletedResult.value) continue;

      const artifactResult = await db.get<Artifact>(entry.value);
      if (artifactResult.value) {
        artifacts.push(artifactResult.value);
      }
    }

    artifacts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const sliced = artifacts.slice(0, limit);
    if (input.includeData === false) {
      return success(sliced.map(toSummary));
    }
    return success(sliced);
  }

  /** List chat artifacts (latest revisions only) */
  async listByChat(input: {
    chatId: string;
    limit?: number;
    includeData?: boolean;
  }): Promise<Result<ArtifactSummary[], string>> {
    using db = await openKv(this.kvPath);

    const artifacts: Artifact[] = [];
    const limit = input.limit ?? 100;

    const entries = db.list<ArtifactKey>({ prefix: ["artifacts_by_chat", input.chatId] });

    for await (const entry of entries) {
      const [, id] = entry.value;

      const deletedResult = await db.get<Date>(keys.deleted(id));
      if (deletedResult.value) continue;

      const artifactResult = await db.get<Artifact>(entry.value);
      if (artifactResult.value) {
        artifacts.push(artifactResult.value);
      }
    }

    artifacts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const sliced = artifacts.slice(0, limit);
    if (input.includeData === false) {
      return success(sliced.map(toSummary));
    }
    return success(sliced);
  }

  /** List all artifacts (latest revisions only) */
  async listAll(input: {
    limit?: number;
    includeData?: boolean;
  }): Promise<Result<ArtifactSummary[], string>> {
    using db = await openKv(this.kvPath);

    const artifacts: Artifact[] = [];
    const limit = input.limit ?? 100;
    const seenIds = new Set<string>();

    const entries = db.list<number>({ prefix: ["artifact_latest"] });

    for await (const entry of entries) {
      const id = entry.key[1] as string;

      if (seenIds.has(id)) continue;
      seenIds.add(id);

      const deletedResult = await db.get<Date>(keys.deleted(id));
      if (deletedResult.value) continue;

      const revision = entry.value;
      const artifactResult = await db.get<Artifact>(keys.artifact(id, revision));
      if (artifactResult.value) {
        artifacts.push(artifactResult.value);
      }
    }

    artifacts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const sliced = artifacts.slice(0, limit);
    if (input.includeData === false) {
      return success(sliced.map(toSummary));
    }
    return success(sliced);
  }

  /** Soft delete (data preserved) */
  async deleteArtifact(input: { id: string }): Promise<Result<void, string>> {
    using db = await openKv(this.kvPath);

    const latestRevisionResult = await db.get<number>(keys.latest(input.id));
    if (!latestRevisionResult.value) {
      return fail(`Artifact ${input.id} not found`);
    }

    const tx = db.atomic();
    tx.set(keys.deleted(input.id), new Date());

    const result = await tx.commit();
    if (!result.ok) {
      return fail("Failed to delete artifact");
    }

    return success(undefined);
  }

  /**
   * Batch get artifacts by IDs (latest revisions only).
   * Missing or deleted artifacts are skipped.
   *
   * Uses a total timeout to prevent cascading delays - if the entire operation
   * takes longer than the timeout, it returns empty results with graceful degradation.
   */
  async getManyLatest(input: { ids: string[] }): Promise<Result<Artifact[], string>> {
    if (!input.ids || input.ids.length === 0) {
      return success([]);
    }

    const TOTAL_TIMEOUT = 5000; // Match HTTP client timeout

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
   * Separated to allow clean timeout handling at the function level.
   */
  private async doGetManyLatest(input: { ids: string[] }): Promise<Result<Artifact[], string>> {
    using db = await openKv(this.kvPath);
    const artifacts: Artifact[] = [];

    for (const id of input.ids) {
      // Skip deleted
      const deletedResult = await db.get<Date>(keys.deleted(id));
      if (deletedResult.value) continue;

      // Resolve latest revision
      const latestRevisionResult = await db.get<number>(keys.latest(id));
      const revision = latestRevisionResult.value;
      if (!revision) continue;

      const artifactResult = await db.get<Artifact>(keys.artifact(id, revision));
      if (artifactResult.value) {
        artifacts.push(artifactResult.value);
      }
    }

    return success(artifacts);
  }

  /**
   * Read file contents for a file artifact.
   * Supports JSON and CSV files.
   */
  async readFileContents(input: {
    id: string;
    revision?: number;
  }): Promise<Result<string, string>> {
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

    const { path, mimeType } = artifact.data.data;

    if (!READABLE_MIME_TYPES.has(mimeType)) {
      return fail(
        `Unsupported mime type for reading: ${mimeType}. Supported: JSON, CSV, plain text, Markdown, YAML.`,
      );
    }

    try {
      const contents = await readFile(path, "utf-8");
      return success(contents);
    } catch (error) {
      logger.error("Failed to read file contents", { path, error: stringifyError(error) });
      return fail(`Failed to read file: ${stringifyError(error)}`);
    }
  }

  /**
   * Read binary contents for a file artifact.
   * Returns raw bytes for any file type (no MIME restriction).
   */
  async readBinaryContents(input: {
    id: string;
    revision?: number;
  }): Promise<Result<Uint8Array, string>> {
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

    const { path } = artifact.data.data;

    try {
      const buffer = await readFile(path);
      return success(new Uint8Array(buffer));
    } catch (error) {
      logger.error("Failed to read binary contents", { path, error: stringifyError(error) });
      return fail(`Failed to read file: ${stringifyError(error)}`);
    }
  }

  /**
   * Read database preview for a database artifact.
   * Returns first N rows with headers and truncation info.
   */
  async readDatabasePreview(
    options: ReadDatabasePreviewOptions,
  ): Promise<Result<DatabasePreview, string>> {
    const DEFAULT_MAX_ROWS = 1000;
    const { id, revision, maxRows = DEFAULT_MAX_ROWS } = options;

    const artifactResult = await this.get({ id, revision });
    if (!artifactResult.ok) {
      return fail(artifactResult.error);
    }

    const artifact = artifactResult.data;
    if (!artifact) {
      return fail(`Artifact ${id} not found`);
    }

    if (artifact.data.type !== "database") {
      return fail(`Artifact ${id} is not a database type`);
    }

    const { path, schema } = artifact.data.data;

    let db: InstanceType<typeof Database> | null = null;
    try {
      db = new Database(path, { readonly: true });
      const tableName = schema.tableName.replace(/"/g, '""');
      const rows = db.prepare(`SELECT * FROM "${tableName}" LIMIT ?`).all(maxRows) as Record<
        string,
        unknown
      >[];

      return success({
        headers: schema.columns.map((c) => c.name),
        rows,
        totalRows: schema.rowCount,
        truncated: schema.rowCount > maxRows,
      });
    } catch (error) {
      logger.error("Failed to read database preview", { id, path, error: stringifyError(error) });
      return fail(`Failed to read database: ${stringifyError(error)}`);
    } finally {
      db?.close();
    }
  }

  /**
   * Get local path to database file.
   * For local storage, the file is already local so no download needed.
   */
  async downloadDatabaseFile(input: {
    id: string;
    revision?: number;
    outputDir?: string;
  }): Promise<Result<{ path: string; isTemporary: boolean }, string>> {
    const artifactResult = await this.get({ id: input.id, revision: input.revision });
    if (!artifactResult.ok) {
      return fail(artifactResult.error);
    }

    const artifact = artifactResult.data;
    if (!artifact) {
      return fail(`Artifact ${input.id} not found`);
    }

    if (artifact.data.type !== "database") {
      return fail(`Artifact ${input.id} is not a database type`);
    }

    // Local storage: file already exists locally, no download needed
    return success({ path: artifact.data.data.path, isTemporary: false });
  }
}

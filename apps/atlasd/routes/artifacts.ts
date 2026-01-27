import { mkdir, unlink, writeFile } from "node:fs/promises";
import { createAnalyticsClient, EventNames } from "@atlas/analytics";
import {
  type ArtifactWithContents,
  CreateArtifactSchema,
  type DatabasePreview,
  UpdateArtifactSchema,
} from "@atlas/core/artifacts";
import { convertCsvToSqlite } from "@atlas/core/artifacts/converters";
import { EXTENSION_TO_MIME, MAX_FILE_SIZE } from "@atlas/core/artifacts/file-upload";
import { ArtifactStorage } from "@atlas/core/artifacts/server";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { Database } from "@db/sqlite";
import { zValidator } from "@hono/zod-validator";
import { dirname, extname, join } from "@std/path";
import { fileTypeFromBlob } from "file-type";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";
import { getCurrentUserId } from "./me/adapter.ts";

const logger = createLogger({ name: "artifacts-upload" });
const analytics = createAnalyticsClient();

type ValidationResult = { valid: true; mimeType: string } | { valid: false; error: string };

/**
 * Check if uploaded file is a CSV using the canonical extension-to-MIME mapping.
 */
function isCsvFile(filename: string): boolean {
  const ext = extname(filename).toLowerCase();
  return EXTENSION_TO_MIME.get(ext) === "text/csv";
}

/**
 * Sanitize filename into valid SQLite table name.
 * Converts to lowercase, replaces non-alphanumeric with underscores,
 * prefixes leading digits, and caps at 64 chars.
 */
function sanitizeTableName(filename: string): string {
  const baseName = filename.replace(/\.csv$/i, "");
  const sanitized = baseName
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/__+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "_$1")
    .slice(0, 64);
  return sanitized || "data";
}

/**
 * Format a value as a CSV cell with proper escaping.
 * Wraps in quotes and escapes embedded quotes if the value contains
 * commas, quotes, or newlines.
 */
function formatCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Validate uploaded file by detecting binary content via magic bytes.
 *
 * Uses file-type package which detects 100+ binary formats. Returns undefined
 * for text files (CSV, JSON, TXT, MD) since they have no magic bytes.
 * This catches renamed binaries: malware.exe -> data.csv still detected as EXE.
 */
async function validateUpload(file: File): Promise<ValidationResult> {
  const detected = await fileTypeFromBlob(file);

  if (detected) {
    // Binary file detected (exe, zip, png, etc.) - reject
    logger.warn("Binary file rejected", {
      filename: file.name,
      detectedType: detected.mime,
      detectedExt: detected.ext,
    });
    return { valid: false, error: "Binary files not allowed. Supported: CSV, JSON, TXT, MD, YML" };
  }

  // No magic bytes = not a known binary format, trust extension
  const ext = `.${file.name.toLowerCase().split(".").pop()}`;
  const mimeType = EXTENSION_TO_MIME.get(ext);
  if (!mimeType) {
    return { valid: false, error: "File type not allowed. Supported: CSV, JSON, TXT, MD, YML" };
  }
  return { valid: true, mimeType };
}

const GetArtifactQuery = z.object({ revision: z.coerce.number().int().positive().optional() });

const ListArtifactsQuery = z.object({
  workspaceId: z.string().optional(),
  chatId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).default(100),
});

const BatchGetBody = z.object({
  ids: z.array(z.string()).min(1).max(1000),
  includeContents: z.boolean().optional(),
});

const artifactsApp = daemonFactory
  .createApp()
  /** Create new artifact */
  .post("/", zValidator("json", CreateArtifactSchema), async (c) => {
    const data = c.req.valid("json");
    const result = await ArtifactStorage.create(data);

    if (!result.ok) {
      return c.json({ error: result.error }, 400);
    }

    // Emit analytics event
    const userId = await getCurrentUserId();
    if (userId) {
      analytics.emit({
        eventName: EventNames.ARTIFACT_CREATED,
        userId,
        workspaceId: result.data.workspaceId,
        attributes: { artifactId: result.data.id, artifactType: result.data.data.type },
      });
    }

    return c.json({ artifact: result.data }, 200);
  })
  /** Update artifact (creates new revision) */
  .put(
    "/:id",
    zValidator("param", z.object({ id: z.string() })),
    zValidator("json", UpdateArtifactSchema),
    async (c) => {
      const { id } = c.req.valid("param");
      const data = c.req.valid("json");
      const result = await ArtifactStorage.update({
        id,
        data: data.data,
        summary: data.summary,
        revisionMessage: data.revisionMessage,
      });

      if (!result.ok) {
        return c.json({ error: result.error }, 400);
      }

      return c.json({ artifact: result.data }, 200);
    },
  )
  /** Batch get artifacts by IDs (latest revisions only) */
  .post("/batch-get", zValidator("json", BatchGetBody), async (c) => {
    const { ids, includeContents } = c.req.valid("json");
    const result = await ArtifactStorage.getManyLatest({ ids });

    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }

    if (!includeContents) {
      return c.json({ artifacts: result.data }, 200);
    }

    // Fetch contents for file artifacts in parallel
    const artifactsWithContents: ArtifactWithContents[] = await Promise.all(
      result.data.map(async (artifact) => {
        if (artifact.data.type !== "file") {
          return artifact;
        }
        const contentsResult = await ArtifactStorage.readFileContents({ id: artifact.id });
        if (contentsResult.ok) {
          return { ...artifact, contents: contentsResult.data };
        }
        // If read fails (binary file, etc.), return artifact without contents
        return artifact;
      }),
    );

    return c.json({ artifacts: artifactsWithContents }, 200);
  })
  /** Get artifact by ID (includes file contents inline for file artifacts, preview for database artifacts) */
  .get(
    "/:id",
    zValidator("param", z.object({ id: z.string() })),
    zValidator("query", GetArtifactQuery.optional()),
    async (c) => {
      const { id } = c.req.valid("param");
      const query = c.req.valid("query");
      const result = await ArtifactStorage.get({ id, revision: query?.revision });

      if (!result.ok) {
        return c.json({ error: result.error }, 500);
      }

      if (!result.data) {
        return c.json({ error: "Artifact not found" }, 404);
      }

      const artifact = result.data;
      let contents: string | undefined;
      let preview: DatabasePreview | undefined;

      // For file artifacts, include contents inline
      if (artifact.data.type === "file") {
        const contentsResult = await ArtifactStorage.readFileContents({
          id,
          revision: query?.revision,
        });
        if (contentsResult.ok) {
          contents = contentsResult.data;
        }
        // If read fails (binary file, etc.), still return artifact metadata
      }

      // For database artifacts, include preview data
      if (artifact.data.type === "database") {
        const previewResult = await ArtifactStorage.readDatabasePreview({
          id,
          revision: query?.revision,
        });
        if (previewResult.ok) {
          preview = previewResult.data;
        } else {
          // Log error but don't fail the request - return artifact without preview
          logger.warn("Failed to read database preview", { id, error: previewResult.error });
        }
      }

      return c.json({ artifact, contents, preview }, 200);
    },
  )
  /** List artifacts - optionally filter by workspace or chat */
  .get("/", zValidator("query", ListArtifactsQuery), async (c) => {
    const query = c.req.valid("query");

    if (query.workspaceId && query.chatId) {
      return c.json({ error: "Cannot specify both workspaceId and chatId" }, 400);
    }

    if (query.workspaceId) {
      const result = await ArtifactStorage.listByWorkspace({
        workspaceId: query.workspaceId,
        limit: query.limit,
      });

      if (!result.ok) {
        return c.json({ error: result.error }, 500);
      }

      return c.json({ artifacts: result.data }, 200);
    }

    if (query.chatId) {
      const result = await ArtifactStorage.listByChat({ chatId: query.chatId, limit: query.limit });

      if (!result.ok) {
        return c.json({ error: result.error }, 500);
      }

      return c.json({ artifacts: result.data }, 200);
    }

    // No filter - return all artifacts
    const result = await ArtifactStorage.listAll({ limit: query.limit });

    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }

    return c.json({ artifacts: result.data }, 200);
  })
  /** Soft delete artifact */
  .delete("/:id", zValidator("param", z.object({ id: z.string() })), async (c) => {
    const { id } = c.req.valid("param");
    const result = await ArtifactStorage.deleteArtifact({ id });

    if (!result.ok) {
      return c.json({ error: result.error }, 404);
    }

    return c.json({ success: true }, 200);
  })
  /** Export database artifact as CSV */
  .get("/:id/export", zValidator("param", z.object({ id: z.string() })), async (c) => {
    const { id } = c.req.valid("param");

    const result = await ArtifactStorage.get({ id });

    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }

    if (!result.data) {
      return c.json({ error: "Artifact not found" }, 404);
    }

    const artifact = result.data;

    if (artifact.data.type !== "database") {
      return c.json({ error: "Export only available for database artifacts" }, 400);
    }

    const { path, schema, sourceFileName } = artifact.data.data;

    // Stream CSV export from SQLite database
    let db: InstanceType<typeof Database> | null = null;
    let iterator: ReturnType<ReturnType<InstanceType<typeof Database>["prepare"]>["iter"]> | null =
      null;

    try {
      db = new Database(path, { readonly: true });
      const tableName = schema.tableName.replace(/"/g, '""');
      const stmt = db.prepare(`SELECT * FROM "${tableName}"`);
      iterator = stmt.iter();

      const columnNames = schema.columns.map((col) => col.name);

      const stream = new ReadableStream({
        start(controller) {
          // Write CSV header row
          const header = `${columnNames.map((name) => formatCsvCell(name)).join(",")}\n`;
          controller.enqueue(new TextEncoder().encode(header));
        },

        pull(controller) {
          try {
            // biome-ignore lint/style/noNonNullAssertion: iterator guaranteed non-null while stream is active
            const result = iterator!.next();
            if (result.done) {
              // Close resources and end stream
              stmt.finalize();
              // biome-ignore lint/style/noNonNullAssertion: db guaranteed non-null while stream is active
              db!.close();
              db = null;
              iterator = null;
              controller.close();
              return;
            }

            const row = result.value as Record<string, unknown>;
            const line = `${columnNames.map((name) => formatCsvCell(row[name])).join(",")}\n`;
            controller.enqueue(new TextEncoder().encode(line));
          } catch (error) {
            // Cleanup on error
            try {
              stmt.finalize();
            } catch {
              // Ignore finalize errors during cleanup
            }
            if (db) {
              db.close();
              db = null;
            }
            iterator = null;
            controller.error(error);
          }
        },

        cancel() {
          // Cleanup when stream is cancelled
          try {
            stmt.finalize();
          } catch {
            // Ignore finalize errors during cleanup
          }
          if (db) {
            db.close();
            db = null;
          }
          iterator = null;
        },
      });

      // Escape filename for Content-Disposition header
      const safeFileName = sourceFileName.replace(/"/g, '\\"');

      return new Response(stream, {
        headers: {
          "Content-Type": "text/csv",
          "Content-Disposition": `attachment; filename="${safeFileName}"`,
        },
      });
    } catch (error) {
      // Cleanup on setup error
      if (db) {
        db.close();
      }
      logger.error("Failed to export database artifact", {
        id,
        path,
        error: stringifyError(error),
      });
      return c.json({ error: "Failed to export database" }, 500);
    }
  })
  /** Upload file as artifact */
  .post("/upload", async (c) => {
    const contentType = c.req.header("content-type") || "";
    if (!contentType.includes("multipart/form-data")) {
      return c.json({ error: "Content-Type must be multipart/form-data" }, 400);
    }

    const formData = await c.req.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return c.json({ error: "file field is required and must be a File" }, 400);
    }

    const chatId = formData.get("chatId")?.toString() || undefined;

    // Path traversal defense - chatId is used in storage path
    if (chatId && (chatId.includes("..") || chatId.startsWith("/"))) {
      return c.json({ error: "Invalid chatId" }, 400);
    }

    // Size validation
    if (file.size > MAX_FILE_SIZE) {
      const maxSizeMB = Math.round(MAX_FILE_SIZE / (1024 * 1024));
      return c.json({ error: `File too large (max ${maxSizeMB}MB)` }, 413);
    }

    // Validate file content via magic bytes detection
    const validation = await validateUpload(file);
    if (!validation.valid) {
      return c.json({ error: validation.error }, 415);
    }

    // Generate storage path: ~/.atlas/uploads/{chatId || 'orphan'}/{uuid}.{ext}
    const atlasHome = getAtlasHome();
    const subdir = chatId || "orphan";
    const uuid = crypto.randomUUID();

    // CSV files get converted to SQLite databases
    if (isCsvFile(file.name)) {
      const tempCsvPath = join(atlasHome, "uploads", subdir, `${uuid}.csv.tmp`);
      const dbPath = join(atlasHome, "uploads", subdir, `${uuid}.db`);

      try {
        // Write temp CSV for streaming (converter needs file path)
        await mkdir(dirname(tempCsvPath), { recursive: true });
        await writeFile(tempCsvPath, new Uint8Array(await file.arrayBuffer()));

        // Convert CSV to SQLite
        const tableName = sanitizeTableName(file.name);
        const { schema } = await convertCsvToSqlite(tempCsvPath, dbPath, tableName);

        // Create database artifact
        const result = await ArtifactStorage.create({
          title: file.name,
          summary: `${schema.rowCount.toLocaleString()} rows, ${schema.columns.length} columns`,
          data: {
            type: "database",
            version: 1,
            data: { path: dbPath, sourceFileName: file.name, schema },
          },
          chatId,
        });

        if (!result.ok) {
          await unlink(dbPath).catch(() => {});
          return c.json({ error: result.error }, 500);
        }

        // Emit analytics event
        const userId = await getCurrentUserId();
        if (userId) {
          analytics.emit({
            eventName: EventNames.ARTIFACT_CREATED,
            userId,
            attributes: { artifactId: result.data.id, artifactType: "database", chatId },
          });
        }

        return c.json({ artifact: result.data }, 201);
      } catch (error) {
        await unlink(dbPath).catch(() => {});

        logger.error("Failed to convert CSV to SQLite", {
          filename: file.name,
          size: file.size,
          error: stringifyError(error),
        });

        return c.json({ error: "CSV conversion failed" }, 500);
      } finally {
        // Always clean up temp CSV file
        await unlink(tempCsvPath).catch(() => {});
      }
    }

    // Non-CSV files: existing file artifact flow
    const ext = extname(file.name) || ".bin";
    const storagePath = join(atlasHome, "uploads", subdir, `${uuid}${ext}`);

    try {
      // Write file to persistent storage
      await mkdir(dirname(storagePath), { recursive: true });
      await writeFile(storagePath, new Uint8Array(await file.arrayBuffer()));

      // Create artifact pointing to stored file
      const result = await ArtifactStorage.create({
        title: file.name,
        summary: `Uploaded file: ${file.name}`,
        data: { type: "file", version: 1, data: { path: storagePath, originalName: file.name } },
        chatId,
      });

      if (!result.ok) {
        // Clean up orphaned file if artifact creation failed
        await unlink(storagePath).catch(() => {});
        return c.json({ error: result.error }, 500);
      }

      // Emit analytics event
      const userId = await getCurrentUserId();
      if (userId) {
        analytics.emit({
          eventName: EventNames.ARTIFACT_CREATED,
          userId,
          attributes: { artifactId: result.data.id, artifactType: "file", chatId },
        });
      }

      return c.json({ artifact: result.data }, 201);
    } catch (error) {
      // Clean up orphaned file if write succeeded but something else failed
      await unlink(storagePath).catch(() => {});

      logger.error("Failed to upload artifact", {
        filename: file.name,
        size: file.size,
        error: stringifyError(error),
      });

      return c.json({ error: "Upload failed" }, 500);
    }
  });

export { artifactsApp };
export type ArtifactsRoutes = typeof artifactsApp;

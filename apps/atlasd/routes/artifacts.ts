import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import process from "node:process";
import { createAnalyticsClient, EventNames } from "@atlas/analytics";
import {
  type ArtifactDataInput,
  type ArtifactWithContents,
  CreateArtifactSchema,
  type DatabasePreview,
  UpdateArtifactSchema,
} from "@atlas/core/artifacts";
import {
  ConverterError,
  convertCsvToSqlite,
  docxToMarkdown,
  pdfToMarkdown,
  pptxToMarkdown,
  USER_FACING_ERROR_CODES,
} from "@atlas/core/artifacts/converters";
import {
  EXTENSION_TO_MIME,
  FILE_TYPE_NOT_ALLOWED_ERROR,
  getValidatedMimeType,
  isAudioMimeType,
  isImageMimeType,
  isInvalidChatId,
  LEGACY_FORMAT_ERRORS,
  MAX_AUDIO_SIZE,
  MAX_FILE_SIZE,
  MAX_IMAGE_SIZE,
  MAX_OFFICE_SIZE,
  MAX_PDF_SIZE,
} from "@atlas/core/artifacts/file-upload";
import { ArtifactStorage } from "@atlas/core/artifacts/server";
import { type PlatformModels, smallLLM } from "@atlas/llm";
import { createLogger } from "@atlas/logger";
import { stringifyError, truncateUnicode } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import { Database } from "@db/sqlite";
import { zValidator } from "@hono/zod-validator";
import { fileTypeFromFile } from "file-type";
import JSZip from "jszip";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";
import { getCurrentUserId } from "./me/adapter.ts";

const logger = createLogger({ name: "artifacts-upload" });
const analytics = createAnalyticsClient();

/** Reverse map: MIME type -> canonical extension (first match wins). */
const MIME_TO_EXTENSION = new Map<string, string>();
for (const [ext, mime] of EXTENSION_TO_MIME) {
  if (!MIME_TO_EXTENSION.has(mime)) MIME_TO_EXTENSION.set(mime, ext);
}

type ValidationResult = { valid: true; mimeType: string } | { valid: false; error: string };

function isPdfFile(filename: string): boolean {
  return getValidatedMimeType(filename) === "application/pdf";
}

function isDocxFile(filename: string): boolean {
  return (
    getValidatedMimeType(filename) ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  );
}

function isPptxFile(filename: string): boolean {
  return (
    getValidatedMimeType(filename) ===
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  );
}

/** MIME types that file-type detects specifically (not as generic application/zip). */
const SPECIFIC_BINARY_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "audio/mpeg",
  "audio/mp4",
  "video/mp4",
  "audio/x-m4a",
  "audio/wav",
  "audio/webm",
  "video/webm",
  "audio/ogg",
  "audio/flac",
]);

type ConvertedFile =
  | { ok: true; title: string; summary: string; data: ArtifactDataInput; markdown?: string }
  | { ok: false; error: string };

/** Convert an uploaded file into artifact data without persisting. Caller handles storage. */
async function convertUploadedFile(opts: {
  filePath: string;
  fileName: string;
}): Promise<ConvertedFile> {
  const { filePath, fileName } = opts;

  const detected = await fileTypeFromFile(filePath);
  const resolvedMime = await resolveFileType(detected, filePath, fileName);

  const extensionMime = getValidatedMimeType(fileName);
  if (resolvedMime && extensionMime && resolvedMime !== extensionMime) {
    logger.warn("File content type differs from extension", {
      fileName,
      extension: extname(fileName).toLowerCase(),
      detectedMime: detected?.mime,
      resolvedMime,
    });
  }

  if (detected && !resolvedMime) {
    await rm(filePath, { force: true });
    const detectedLabel = (detected.ext ?? "unknown").toUpperCase();
    return {
      ok: false,
      error: `Detected ${detectedLabel} content, which is not a supported format. Supported: PDF, DOCX, PPTX, PNG, JPG, WebP, GIF, MP3, MP4, M4A, WAV, WebM, OGG, FLAC`,
    };
  }

  const usingCortex = process.env.ARTIFACT_STORAGE_ADAPTER === "cortex";
  const artifactsDir = usingCortex
    ? join(tmpdir(), "atlas-artifacts")
    : join(getFridayHome(), "uploads", "artifacts");
  await mkdir(artifactsDir, { recursive: true });

  const ext = extname(fileName).toLowerCase();
  const resolvedExt = resolvedMime ? (MIME_TO_EXTENSION.get(resolvedMime) ?? ext) : ext;

  // CSV -> SQLite
  if (resolvedMime === "text/csv") {
    const dbPath = join(artifactsDir, `${crypto.randomUUID()}.db`);
    try {
      const tableName = sanitizeTableName(fileName);
      const { schema } = await convertCsvToSqlite(filePath, dbPath, tableName);
      return {
        ok: true,
        title: fileName,
        summary: `${schema.rowCount.toLocaleString()} rows, ${schema.columns.length} columns`,
        data: {
          type: "file",
          version: 1,
          data: { path: dbPath, sourceFileName: fileName, schema },
        },
      };
    } catch (error) {
      await unlink(dbPath).catch(() => {});
      logger.error("Failed to convert CSV to SQLite", {
        filename: fileName,
        error: stringifyError(error),
      });
      return { ok: false, error: "CSV conversion failed" };
    } finally {
      await unlink(filePath).catch(() => {});
    }
  }

  // PDF -> markdown
  if (resolvedMime === "application/pdf") {
    return convertUploadedBinary({
      filePath,
      fileName,
      artifactsDir,
      converter: pdfToMarkdown,
      formatLabel: "PDF",
      maxSize: MAX_PDF_SIZE,
      placeholderSummary: (md) => {
        const pageCount = (md.match(/## Page \d+/g) ?? []).length;
        return `PDF document, ${pageCount} page${pageCount !== 1 ? "s" : ""}`;
      },
    });
  }

  // DOCX -> markdown
  if (resolvedMime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    return convertUploadedBinary({
      filePath,
      fileName,
      artifactsDir,
      converter: docxToMarkdown,
      formatLabel: "DOCX",
      maxSize: MAX_OFFICE_SIZE,
      placeholderSummary: () => "DOCX document",
    });
  }

  // PPTX -> markdown
  if (
    resolvedMime === "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return convertUploadedBinary({
      filePath,
      fileName,
      artifactsDir,
      converter: pptxToMarkdown,
      formatLabel: "PPTX",
      maxSize: MAX_OFFICE_SIZE,
      placeholderSummary: (md) => {
        const slideCount = (md.match(/## Slide \d+/g) ?? []).length;
        return `PPTX presentation, ${slideCount} slide${slideCount !== 1 ? "s" : ""}`;
      },
    });
  }

  // Image files — store as-is
  if (resolvedMime && isImageMimeType(resolvedMime)) {
    try {
      const { size } = await stat(filePath);
      if (size > MAX_IMAGE_SIZE) {
        await rm(filePath, { force: true });
        return { ok: false, error: "Image files must be under 5MB." };
      }

      const persistedImagePath = join(artifactsDir, `${crypto.randomUUID()}${resolvedExt}`);
      await copyFile(filePath, persistedImagePath);
      await unlink(filePath).catch(() => {});

      return {
        ok: true,
        title: fileName,
        summary: `Image: ${fileName}`,
        data: {
          type: "file",
          version: 1,
          data: { path: persistedImagePath, originalName: fileName },
        },
      };
    } catch (error) {
      await unlink(filePath).catch(() => {});
      logger.error("Failed to process image file", {
        filename: fileName,
        error: stringifyError(error),
      });
      return { ok: false, error: "Upload failed" };
    }
  }

  // Audio files — store as-is (transcription happens downstream)
  if (resolvedMime && isAudioMimeType(resolvedMime)) {
    try {
      const { size } = await stat(filePath);
      if (size > MAX_AUDIO_SIZE) {
        await rm(filePath, { force: true });
        return { ok: false, error: "Audio files must be under 25MB." };
      }

      const persistedAudioPath = join(artifactsDir, `${crypto.randomUUID()}${resolvedExt}`);
      await copyFile(filePath, persistedAudioPath);
      await unlink(filePath).catch(() => {});

      return {
        ok: true,
        title: fileName,
        summary: `Audio: ${fileName}`,
        data: {
          type: "file",
          version: 1,
          data: { path: persistedAudioPath, originalName: fileName },
        },
      };
    } catch (error) {
      await unlink(filePath).catch(() => {});
      logger.error("Failed to process audio file", {
        filename: fileName,
        error: stringifyError(error),
      });
      return { ok: false, error: "Upload failed" };
    }
  }

  // Other text files — copy as-is
  const persistedPath = join(artifactsDir, `${crypto.randomUUID()}${resolvedExt || ".txt"}`);
  try {
    await copyFile(filePath, persistedPath);
    await unlink(filePath).catch(() => {});

    return {
      ok: true,
      title: fileName,
      summary: `Uploaded file: ${fileName}`,
      data: { type: "file", version: 1, data: { path: persistedPath, originalName: fileName } },
    };
  } catch (error) {
    await unlink(persistedPath).catch(() => {});
    await unlink(filePath).catch(() => {});
    logger.error("Failed to process file", { filename: fileName, error: stringifyError(error) });
    return { ok: false, error: "Upload failed" };
  }
}

/** Convert a binary document (PDF/DOCX/PPTX) to markdown. Returns data envelope + markdown for LLM summarization. */
async function convertUploadedBinary(opts: {
  filePath: string;
  fileName: string;
  artifactsDir: string;
  converter: (buffer: Uint8Array, filename: string) => Promise<string>;
  formatLabel: string;
  maxSize: number;
  placeholderSummary: (markdown: string) => string;
}): Promise<ConvertedFile> {
  const { filePath, fileName, artifactsDir, converter, formatLabel, maxSize, placeholderSummary } =
    opts;
  const mdPath = join(artifactsDir, `${crypto.randomUUID()}.md`);
  try {
    const { size } = await stat(filePath);
    if (size > maxSize) {
      await rm(filePath, { force: true });
      const maxSizeMB = Math.round(maxSize / (1024 * 1024));
      return { ok: false, error: `${formatLabel} too large (max ${maxSizeMB}MB)` };
    }

    const buffer = await readFile(filePath);
    const markdown = await converter(buffer, fileName);
    await writeFile(mdPath, markdown, "utf-8");

    const summary = placeholderSummary(markdown);

    return {
      ok: true,
      title: fileName,
      summary,
      data: { type: "file", version: 1, data: { path: mdPath, originalName: fileName } },
      markdown,
    };
  } catch (error) {
    await unlink(mdPath).catch(() => {});
    const isUserFacing = error instanceof ConverterError && USER_FACING_ERROR_CODES.has(error.code);
    const message = error instanceof Error ? error.message : "";
    logger.error(`Failed to convert ${formatLabel} to markdown`, {
      filename: fileName,
      error: stringifyError(error),
    });
    return { ok: false, error: isUserFacing ? message : `${formatLabel} conversion failed` };
  } finally {
    await unlink(filePath).catch(() => {});
  }
}

/**
 * Resolve file content type using magic bytes first, extension as fallback.
 *
 * Resolution priority:
 * 1. file-type magic bytes -> specific MIME (PDF, PNG, JPEG, DOCX, PPTX, etc.)
 * 2. file-type returns application/zip -> JSZip peek for OOXML markers
 * 3. file-type returns undefined (text formats) -> extension-based mapping
 *
 * Returns undefined when neither magic bytes nor extension produce a supported MIME.
 */
export async function resolveFileType(
  detected: { mime: string; ext: string } | undefined,
  filePath: string,
  fileName: string,
): Promise<string | undefined> {
  if (!detected) {
    return getValidatedMimeType(fileName);
  }

  const baseMime = detected.mime.split(";")[0] ?? detected.mime;
  if (SPECIFIC_BINARY_MIMES.has(baseMime)) {
    return baseMime;
  }

  if (detected.mime === "application/zip") {
    try {
      const fileStat = await stat(filePath);
      if (fileStat.size > MAX_OFFICE_SIZE) {
        return undefined;
      }
      const buffer = await readFile(filePath);
      const zip = await JSZip.loadAsync(buffer);
      if (zip.file("word/document.xml")) {
        return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
      }
      if (zip.file("ppt/presentation.xml")) {
        return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
      }
    } catch {
      // Corrupt or unreadable ZIP
    }
    return undefined;
  }

  return undefined;
}

/** Sanitize filename into valid SQLite table name. */
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

/** Format a value as a CSV cell with proper escaping. */
function formatCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Validate uploaded file extension. Magic byte detection happens later in createArtifactFromFile. */
function validateUpload(file: File): ValidationResult {
  const mimeType = getValidatedMimeType(file.name);
  if (!mimeType) {
    return { valid: false, error: FILE_TYPE_NOT_ALLOWED_ERROR };
  }
  return { valid: true, mimeType };
}

/** Stream a ReadableStream to disk with backpressure handling. Creates parent directory. */
export async function streamToFile(
  stream: ReadableStream<Uint8Array>,
  destPath: string,
): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  const writer = createWriteStream(destPath);

  try {
    for await (const chunk of stream) {
      const ok = writer.write(chunk);
      if (!ok) await new Promise<void>((resolve) => writer.once("drain", () => resolve()));
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      writer.end((err?: Error | null) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared artifact creation (used by single-upload and chunked-upload)
// ─────────────────────────────────────────────────────────────────────────────

async function emitArtifactCreatedEvent(artifactId: string, artifactType: string, chatId?: string) {
  const userId = await getCurrentUserId();
  if (userId) {
    analytics.emit({
      eventName: EventNames.ARTIFACT_CREATED,
      userId,
      attributes: { artifactId, artifactType, chatId },
    });
  }
}

/** Convert file on disk and persist as artifact via ArtifactStorage.create. */
export async function createArtifactFromFile(opts: {
  filePath: string;
  fileName: string;
  chatId?: string;
  workspaceId?: string;
  platformModels: PlatformModels;
}) {
  const { filePath, fileName, chatId, workspaceId, platformModels } = opts;

  // Legacy format check — reject .doc/.ppt with helpful message
  const ext = extname(fileName).toLowerCase();
  const legacyError = LEGACY_FORMAT_ERRORS.get(ext);
  if (legacyError) {
    await rm(filePath, { force: true });
    return { ok: false as const, error: legacyError };
  }

  const converted = await convertUploadedFile({ filePath, fileName });
  if (!converted.ok) {
    return { ok: false as const, error: converted.error };
  }

  const result = await ArtifactStorage.create({
    title: converted.title,
    summary: converted.summary,
    data: converted.data,
    chatId,
    workspaceId,
  });

  if (!result.ok) {
    logger.error("ArtifactStorage.create failed", { filename: fileName, error: result.error });
    const fileData = converted.data.data;
    if (typeof fileData === "object" && fileData !== null && "path" in fileData) {
      await unlink(fileData.path).catch(() => {});
    }
    return { ok: false as const, error: result.error };
  }

  // Cortex uploaded the file — local copy is no longer needed
  const usingCortex = process.env.ARTIFACT_STORAGE_ADAPTER === "cortex";
  const fileData = converted.data.data;
  if (usingCortex && typeof fileData === "object" && fileData !== null && "path" in fileData) {
    await unlink(fileData.path).catch((err) => {
      logger.debug("Failed to cleanup temp file after Cortex upload", {
        path: fileData.path,
        error: stringifyError(err),
      });
    });
  }

  await emitArtifactCreatedEvent(result.data.id, converted.data.type, chatId);

  // Fire-and-forget: LLM summary for converted documents
  if (converted.markdown) {
    const { data, markdown } = converted;
    const artifactId = result.data.id;
    const truncated = markdown.slice(0, 2000);
    smallLLM({
      platformModels,
      system:
        "Summarize the document in one sentence (max 120 chars). No quotes, no preamble, just the summary.",
      prompt: truncated,
      maxOutputTokens: 250,
    })
      .then(async (llmSummary) => {
        const trimmed = truncateUnicode(llmSummary.trim(), 200);
        if (trimmed) {
          await ArtifactStorage.update({ id: artifactId, summary: trimmed, data });
        }
      })
      .catch((err) => {
        logger.debug("Failed to generate document summary via LLM", { error: stringifyError(err) });
      });
  }

  return { ok: true as const, artifact: result.data };
}

/** Replace an artifact's content with a new file. Creates a new revision via ArtifactStorage.update. */
export async function replaceArtifactFromFile(opts: {
  artifactId: string;
  filePath: string;
  fileName: string;
  platformModels: PlatformModels;
}) {
  const { artifactId, filePath, fileName, platformModels } = opts;

  // Legacy format check — reject .doc/.ppt with helpful message
  const ext = extname(fileName).toLowerCase();
  const legacyError = LEGACY_FORMAT_ERRORS.get(ext);
  if (legacyError) {
    await rm(filePath, { force: true });
    return { ok: false as const, error: legacyError };
  }

  const converted = await convertUploadedFile({ filePath, fileName });
  if (!converted.ok) {
    return { ok: false as const, error: converted.error };
  }

  const result = await ArtifactStorage.update({
    id: artifactId,
    title: converted.title,
    summary: converted.summary,
    data: converted.data,
  });

  if (!result.ok) {
    logger.error("ArtifactStorage.update failed for replace", {
      artifactId,
      filename: fileName,
      error: result.error,
    });
    const replaceData = converted.data.data;
    if (typeof replaceData === "object" && replaceData !== null && "path" in replaceData) {
      await unlink(replaceData.path).catch(() => {});
    }
    return { ok: false as const, error: result.error };
  }

  const usingCortex = process.env.ARTIFACT_STORAGE_ADAPTER === "cortex";
  const replaceCleanupData = converted.data.data;
  if (
    usingCortex &&
    typeof replaceCleanupData === "object" &&
    replaceCleanupData !== null &&
    "path" in replaceCleanupData
  ) {
    await unlink(replaceCleanupData.path).catch((err) => {
      logger.debug("Failed to cleanup temp file after Cortex upload", {
        path: replaceCleanupData.path,
        error: stringifyError(err),
      });
    });
  }

  // Fire-and-forget: LLM summary for converted documents
  if (converted.markdown) {
    const { data, markdown } = converted;
    const truncated = markdown.slice(0, 2000);
    smallLLM({
      platformModels,
      system:
        "Summarize the document in one sentence (max 120 chars). No quotes, no preamble, just the summary.",
      prompt: truncated,
      maxOutputTokens: 250,
    })
      .then(async (llmSummary) => {
        const trimmed = truncateUnicode(llmSummary.trim(), 200);
        if (trimmed) {
          await ArtifactStorage.update({ id: artifactId, summary: trimmed, data });
        }
      })
      .catch((err) => {
        logger.debug("Failed to generate document summary via LLM", { error: stringifyError(err) });
      });
  }

  return { ok: true as const, artifact: result.data };
}

const GetArtifactQuery = z.object({ revision: z.coerce.number().int().positive().optional() });

const ListArtifactsQuery = z.object({
  workspaceId: z.string().optional(),
  chatId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(1000).default(100),
  includeData: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
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

    return c.json({ artifact: result.data }, 201);
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

      // For SQLite database artifacts, include preview data
      if (artifact.data.data.mimeType === "application/x-sqlite3") {
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
        includeData: query.includeData,
      });

      if (!result.ok) {
        return c.json({ error: result.error }, 500);
      }

      return c.json({ artifacts: result.data }, 200);
    }

    if (query.chatId) {
      const result = await ArtifactStorage.listByChat({
        chatId: query.chatId,
        limit: query.limit,
        includeData: query.includeData,
      });

      if (!result.ok) {
        return c.json({ error: result.error }, 500);
      }

      return c.json({ artifacts: result.data }, 200);
    }

    // No filter - return all artifacts
    const result = await ArtifactStorage.listAll({
      limit: query.limit,
      includeData: query.includeData,
    });

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

    if (artifact.data.data.mimeType !== "application/x-sqlite3" || !artifact.data.data.schema) {
      return c.json({ error: "Export only available for SQLite database artifacts" }, 400);
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

      // Escape backslashes first, then double-quotes — without the backslash
      // pass, a name containing `\"` would become `\\"` (a literal backslash
      // followed by an unescaped quote that closes the header value early).
      const safeFileName = (sourceFileName ?? "export.csv")
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');

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
  /** Serve raw binary content for file artifacts */
  .get(
    "/:id/content",
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
      if (artifact.data.type !== "file") {
        return c.json({ error: "Content endpoint only supports file artifacts" }, 404);
      }

      const binaryResult = await ArtifactStorage.readBinaryContents({
        id,
        revision: query?.revision,
      });
      if (!binaryResult.ok) {
        return c.json({ error: binaryResult.error }, 500);
      }

      const { mimeType } = artifact.data.data;
      const disposition = isImageMimeType(mimeType) ? "inline" : "attachment";

      const body = new Uint8Array(binaryResult.data);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": mimeType,
          "Content-Length": String(body.byteLength),
          "Content-Disposition": disposition,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, max-age=31536000, immutable",
        },
      });
    },
  )
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
    const workspaceId = formData.get("workspaceId")?.toString() || undefined;
    const artifactId = formData.get("artifactId")?.toString() || undefined;

    // Path traversal defense - these values are used in storage lookups
    if (chatId && isInvalidChatId(chatId)) {
      return c.json({ error: "Invalid chatId" }, 400);
    }
    if (artifactId && isInvalidChatId(artifactId)) {
      return c.json({ error: "Invalid artifactId" }, 400);
    }
    if (workspaceId && isInvalidChatId(workspaceId)) {
      return c.json({ error: "Invalid workspaceId" }, 400);
    }

    // Legacy format check — reject .doc/.ppt with helpful message
    const uploadExt = extname(file.name).toLowerCase();
    const uploadLegacyError = LEGACY_FORMAT_ERRORS.get(uploadExt);
    if (uploadLegacyError) {
      return c.json({ error: uploadLegacyError }, 415);
    }

    // Size validation - type-specific limits enforced before the general limit
    if (isPdfFile(file.name) && file.size > MAX_PDF_SIZE) {
      const maxSizeMB = Math.round(MAX_PDF_SIZE / (1024 * 1024));
      return c.json({ error: `PDF too large (max ${maxSizeMB}MB)` }, 413);
    }
    if ((isDocxFile(file.name) || isPptxFile(file.name)) && file.size > MAX_OFFICE_SIZE) {
      const maxSizeMB = Math.round(MAX_OFFICE_SIZE / (1024 * 1024));
      return c.json(
        { error: `${uploadExt.slice(1).toUpperCase()} too large (max ${maxSizeMB}MB)` },
        413,
      );
    }
    const mimeType = getValidatedMimeType(file.name);
    if (mimeType && isImageMimeType(mimeType) && file.size > MAX_IMAGE_SIZE) {
      return c.json({ error: "Image files must be under 5MB." }, 413);
    }
    if (mimeType && isAudioMimeType(mimeType) && file.size > MAX_AUDIO_SIZE) {
      return c.json({ error: "Audio files must be under 25MB." }, 413);
    }
    if (file.size > MAX_FILE_SIZE) {
      const maxSizeMB = Math.round(MAX_FILE_SIZE / (1024 * 1024));
      return c.json({ error: `File too large (max ${maxSizeMB}MB)` }, 413);
    }

    const validation = validateUpload(file);
    if (!validation.valid) {
      return c.json({ error: validation.error }, 415);
    }

    // Stream file to /tmp, then createArtifactFromFile persists to FRIDAY_HOME
    const uploadTmpDir = join(tmpdir(), "atlas-upload");
    await mkdir(uploadTmpDir, { recursive: true });
    const uuid = crypto.randomUUID();
    const ext = extname(file.name) || ".txt";
    const filePath = join(uploadTmpDir, `${uuid}${ext}`);

    try {
      await streamToFile(file.stream(), filePath);
    } catch (error) {
      await unlink(filePath).catch(() => {});
      logger.error("Failed to write uploaded file", {
        filename: file.name,
        size: file.size,
        error: stringifyError(error),
      });
      return c.json({ error: "Upload failed" }, 500);
    }

    const platformModels = c.get("app").daemon.getPlatformModels();

    if (artifactId) {
      const result = await replaceArtifactFromFile({
        artifactId,
        filePath,
        fileName: file.name,
        platformModels,
      });
      if (!result.ok) {
        return c.json({ error: result.error }, 500);
      }
      return c.json({ artifact: result.artifact }, 201);
    }

    const result = await createArtifactFromFile({
      filePath,
      fileName: file.name,
      chatId,
      workspaceId,
      platformModels,
    });
    if (!result.ok) {
      return c.json({ error: result.error }, 500);
    }
    return c.json({ artifact: result.artifact }, 201);
  });

export { artifactsApp };
export type ArtifactsRoutes = typeof artifactsApp;

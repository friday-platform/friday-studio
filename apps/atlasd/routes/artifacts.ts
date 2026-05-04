import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import {
  type ArtifactDataInput,
  type ArtifactWithContents,
  CreateArtifactSchema,
  UpdateArtifactSchema,
} from "@atlas/core/artifacts";
import {
  ConverterError,
  docxToMarkdown,
  pdfToMarkdown,
  pptxToMarkdown,
  USER_FACING_ERROR_CODES,
} from "@atlas/core/artifacts/converters";
import {
  deriveDownloadFilename,
  FILE_TYPE_NOT_ALLOWED_ERROR,
  getValidatedMimeType,
  isAudioMimeType,
  isImageMimeType,
  isInvalidChatId,
  isParseableMimeType,
  isTextMimeType,
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
import { zValidator } from "@hono/zod-validator";
import { fileTypeFromFile } from "file-type";
import JSZip from "jszip";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";

const logger = createLogger({ name: "artifacts-upload" });

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

  // PDF -> markdown
  if (resolvedMime === "application/pdf") {
    return convertUploadedBinary({
      filePath,
      fileName,
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
      converter: pptxToMarkdown,
      formatLabel: "PPTX",
      maxSize: MAX_OFFICE_SIZE,
      placeholderSummary: (md) => {
        const slideCount = (md.match(/## Slide \d+/g) ?? []).length;
        return `PPTX presentation, ${slideCount} slide${slideCount !== 1 ? "s" : ""}`;
      },
    });
  }

  // Image files — read into bytes, hand off to storage (Object Store
  // dedups identical bytes by SHA-256).
  if (resolvedMime && isImageMimeType(resolvedMime)) {
    try {
      const { size } = await stat(filePath);
      if (size > MAX_IMAGE_SIZE) {
        await rm(filePath, { force: true });
        return { ok: false, error: "Image files must be under 5MB." };
      }
      const bytes = new Uint8Array(await readFile(filePath));
      await unlink(filePath).catch(() => {});
      return {
        ok: true,
        title: fileName,
        summary: `Image: ${fileName}`,
        data: { type: "file", content: bytes, mimeType: resolvedMime, originalName: fileName },
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

  // Audio files — read into bytes, hand off to storage.
  if (resolvedMime && isAudioMimeType(resolvedMime)) {
    try {
      const { size } = await stat(filePath);
      if (size > MAX_AUDIO_SIZE) {
        await rm(filePath, { force: true });
        return { ok: false, error: "Audio files must be under 25MB." };
      }
      const bytes = new Uint8Array(await readFile(filePath));
      await unlink(filePath).catch(() => {});
      return {
        ok: true,
        title: fileName,
        summary: `Audio: ${fileName}`,
        data: { type: "file", content: bytes, mimeType: resolvedMime, originalName: fileName },
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

  // Other text files — read into bytes; let storage sniff/override mime.
  try {
    const bytes = new Uint8Array(await readFile(filePath));
    await unlink(filePath).catch(() => {});
    return {
      ok: true,
      title: fileName,
      summary: `Uploaded file: ${fileName}`,
      data: {
        type: "file",
        content: bytes,
        ...(resolvedMime ? { mimeType: resolvedMime } : {}),
        originalName: fileName,
      },
    };
  } catch (error) {
    await unlink(filePath).catch(() => {});
    logger.error("Failed to process file", { filename: fileName, error: stringifyError(error) });
    return { ok: false, error: "Upload failed" };
  }
}

/** Convert a binary document (PDF/DOCX/PPTX) to markdown. Returns data envelope + markdown for LLM summarization. */
async function convertUploadedBinary(opts: {
  filePath: string;
  fileName: string;
  converter: (buffer: Uint8Array, filename: string) => Promise<string>;
  formatLabel: string;
  maxSize: number;
  placeholderSummary: (markdown: string) => string;
}): Promise<ConvertedFile> {
  const { filePath, fileName, converter, formatLabel, maxSize, placeholderSummary } = opts;
  try {
    const { size } = await stat(filePath);
    if (size > maxSize) {
      await rm(filePath, { force: true });
      const maxSizeMB = Math.round(maxSize / (1024 * 1024));
      return { ok: false, error: `${formatLabel} too large (max ${maxSizeMB}MB)` };
    }

    const buffer = await readFile(filePath);
    const markdown = await converter(buffer, fileName);

    const summary = placeholderSummary(markdown);
    const mdName = fileName.replace(/\.[^.]+$/, "") + ".md";

    return {
      ok: true,
      title: fileName,
      summary,
      data: { type: "file", content: markdown, mimeType: "text/markdown", originalName: mdName },
      markdown,
    };
  } catch (error) {
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
    return { ok: false as const, error: result.error };
  }

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
    return { ok: false as const, error: result.error };
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

/**
 * When an artifact lookup misses, the cause may be the in-flight
 * artifacts-to-jetstream / repair-artifact-object-store-v2 migration
 * rather than missing data. Returns a 503 body if so, otherwise null
 * (caller should fall through to its own 404 response).
 */
function migrationStateError(
  migrations: { state: "pending" } | { state: "complete"; result: { failed: string[] } },
): { status: 503; body: Record<string, unknown> } | null {
  if (migrations.state === "pending") {
    return {
      status: 503,
      body: { error: "Artifact migration in progress — retry shortly", migrating: true },
    };
  }
  const failed = migrations.result.failed;
  if (
    failed.includes("artifacts-to-jetstream") ||
    failed.includes("repair-artifact-object-store-v2")
  ) {
    return {
      status: 503,
      body: {
        error:
          "Artifact migration failed — see daemon logs. The artifact may need to be re-uploaded.",
        migrationFailed: true,
      },
    };
  }
  return null;
}

const artifactsApp = daemonFactory
  .createApp()
  /** Create new artifact */
  .post("/", zValidator("json", CreateArtifactSchema), async (c) => {
    const data = c.req.valid("json");
    const result = await ArtifactStorage.create(data);

    if (!result.ok) {
      return c.json({ error: result.error }, 400);
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
        ...(data.title !== undefined ? { title: data.title } : {}),
        summary: data.summary,
        ...(data.revisionMessage !== undefined ? { revisionMessage: data.revisionMessage } : {}),
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
        const migErr = migrationStateError(c.get("app").daemon.getStatus().migrations);
        if (migErr) return c.json(migErr.body, migErr.status);
        return c.json({ error: "Artifact not found" }, 404);
      }

      const artifact = result.data;
      let contents: string | undefined;
      let hint: string | undefined;

      // Only return decoded contents for text-like mime types. Binary
      // formats (PDF, images, audio, zip, etc.) get a hint instead — the
      // model can't usefully reason about TextDecoder-mangled bytes, and
      // shipping them through the prompt is expensive. Binary callers
      // should use `parse_artifact` for PDF/DOCX/PPTX text extraction or
      // `display_artifact` for visual rendering.
      if (artifact.data.type === "file") {
        const mime = artifact.data.mimeType;
        if (isTextMimeType(mime)) {
          const contentsResult = await ArtifactStorage.readFileContents({
            id,
            revision: query?.revision,
          });
          if (contentsResult.ok) {
            contents = contentsResult.data;
          }
        } else if (isParseableMimeType(mime)) {
          hint = `Binary artifact (${mime}). Call parse_artifact with this artifactId to extract text contents, or display_artifact to show the user.`;
        } else if (isImageMimeType(mime)) {
          hint = `Image artifact (${mime}). Call display_artifact to show the user — the model cannot reason about image bytes directly.`;
        } else {
          hint = `Binary artifact (${mime}). Call display_artifact to show the user, or fetch /api/artifacts/${id}/content from run_code to process the bytes server-side.`;
        }
      }

      return c.json({ artifact, contents, hint }, 200);
    },
  )
  /**
   * Server-side text extraction for binary artifacts. Routes the bytes
   * through whichever converter matches the mime type — same converters
   * used at upload time. Saves the model from trying to do PDF parsing
   * itself by round-tripping bytes through `run_code`, which costs
   * thousands of prompt tokens per page and frequently fails on larger
   * documents. Result is markdown text, suitable for direct LLM reasoning.
   */
  .get("/:id/parse", zValidator("param", z.object({ id: z.string() })), async (c) => {
    const { id } = c.req.valid("param");
    const meta = await ArtifactStorage.get({ id });
    if (!meta.ok) return c.json({ error: meta.error }, 500);
    if (!meta.data) return c.json({ error: "Artifact not found" }, 404);
    if (meta.data.data.type !== "file") {
      return c.json({ error: "Artifact is not a file" }, 400);
    }
    const mime = meta.data.data.mimeType;
    if (!isParseableMimeType(mime)) {
      return c.json(
        {
          error: `parse_artifact does not support mime type ${mime}. Supported: PDF, DOCX, PPTX. For text artifacts use artifacts_get; for images use display_artifact.`,
        },
        400,
      );
    }
    const bytes = await ArtifactStorage.readBinaryContents({ id });
    if (!bytes.ok) return c.json({ error: bytes.error }, 500);
    const filename = meta.data.data.originalName ?? meta.data.title ?? id;
    try {
      let markdown: string;
      if (mime === "application/pdf") {
        markdown = await pdfToMarkdown(bytes.data, filename);
      } else if (
        mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ) {
        markdown = await docxToMarkdown(bytes.data, filename);
      } else {
        markdown = await pptxToMarkdown(bytes.data, filename);
      }
      return c.json({ markdown, mimeType: mime, filename }, 200);
    } catch (err) {
      if (err instanceof ConverterError) {
        return c.json({ error: err.message, code: err.code }, 422);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `Failed to parse artifact: ${msg}` }, 500);
    }
  })
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
        const migErr = migrationStateError(c.get("app").daemon.getStatus().migrations);
        if (migErr) return c.json(migErr.body, migErr.status);
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

      const { mimeType, originalName } = artifact.data;
      // Mimes the browser renders inline in an `<iframe>` or `<img>`. Anything
      // else triggers a download. PDFs and HTML need `inline` so the chat
      // UI's artifact-card iframe shows a preview instead of pulling down a
      // copy and leaving the iframe blank.
      const isInlineRenderable =
        isImageMimeType(mimeType) ||
        mimeType === "application/pdf" ||
        mimeType === "text/html" ||
        mimeType === "text/plain";
      const disposition = isInlineRenderable ? "inline" : "attachment";

      // Filename hint so the browser uses something meaningful when the user
      // saves (Right-click → Save As, or attachment-disposition downloads).
      // Without it the browser falls back to the URL's last path segment —
      // every download lands as "content", "content (1)", etc.
      //
      // `deriveDownloadFilename` reconciles the stored `originalName` with
      // the actual `mimeType`. Legacy artifacts where the scrubber stamped
      // a `.bin` filename pre-mime-sniff get their extension repaired at
      // download time; future scrubber lifts already pick the right
      // extension via base64 magic-byte detection.
      //
      // RFC 6266: `filename=` is the ASCII fallback (quotes/backslashes
      // escaped); `filename*=UTF-8''…` carries the real value for any
      // non-ASCII. Modern browsers prefer filename*.
      const rawName = deriveDownloadFilename({ mimeType, originalName, title: artifact.title });
      const asciiName = rawName.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");
      const utf8Name = encodeURIComponent(rawName);
      const contentDisposition = `${disposition}; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`;
      // Sandbox active-content mimes. The CSP `sandbox` directive (and
      // the matching iframe `sandbox` attribute) drops the document
      // into an opaque origin, which is the actual security boundary —
      // scripts in the iframe can't reach the parent's cookies, storage,
      // or DOM via the same-origin policy.
      //
      // HTML opts into `allow-scripts` so legit agent-rendered pages
      // (Leaflet maps, charts, embedded viewers) actually run. The
      // opaque-origin sandbox still blocks parent access, so this is
      // not a regression on the threat model — it just lets the iframe
      // execute the JS the agent wrote, which is the whole point of
      // rendering HTML.
      //
      // SVG stays scriptless: when a user views what's nominally an
      // image, no `<script>` should ever execute, regardless of source.
      let contentSecurityPolicy: string | undefined;
      if (mimeType === "text/html") {
        contentSecurityPolicy =
          "sandbox allow-scripts; default-src https: data: blob: 'unsafe-inline' 'unsafe-eval'";
      } else if (mimeType === "image/svg+xml") {
        contentSecurityPolicy =
          "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'";
      }

      const body = new Uint8Array(binaryResult.data);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": mimeType,
          "Content-Length": String(body.byteLength),
          "Content-Disposition": contentDisposition,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, max-age=31536000, immutable",
          ...(contentSecurityPolicy ? { "Content-Security-Policy": contentSecurityPolicy } : {}),
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

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import {
  CHUNK_SIZE,
  CHUNKED_UPLOAD_TTL_MS,
  FILE_TYPE_NOT_ALLOWED_ERROR,
  getValidatedMimeType,
  isInvalidChatId,
  MAX_FILE_SIZE,
} from "@atlas/core/artifacts/file-upload";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { zValidator } from "@hono/zod-validator";
import { dirname, extname, join } from "@std/path";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";
import { createArtifactFromFile, streamToFile } from "./artifacts.ts";

const logger = createLogger({ name: "chunked-upload" });

// ─────────────────────────────────────────────────────────────────────────────
// Upload session management
// ─────────────────────────────────────────────────────────────────────────────

interface UploadSession {
  uploadId: string;
  fileName: string;
  fileSize: number;
  totalChunks: number;
  completedChunks: Set<number>;
  chatId?: string;
  tempDir: string;
  createdAt: number;
  status: "uploading" | "completing" | "failed";
}

const sessions = new Map<string, UploadSession>();

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
export const MAX_CONCURRENT_SESSIONS = 5;

async function cleanupExpiredSessions(): Promise<void> {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > CHUNKED_UPLOAD_TTL_MS) {
      sessions.delete(id);
      await rm(session.tempDir, { recursive: true, force: true }).catch(() => {});
      logger.info("Cleaned up expired upload session", { uploadId: id });
    }
  }
}

/** Remove temp dirs from previous runs not tracked by active sessions. */
async function cleanupOrphanedTempDirs(): Promise<void> {
  const chunkedDir = join(getAtlasHome(), "uploads", "chunked");
  let entries: string[];
  try {
    entries = await readdir(chunkedDir);
  } catch {
    return; // Directory doesn't exist yet
  }

  const activeDirs = new Set([...sessions.values()].map((s) => s.uploadId));

  for (const entry of entries) {
    if (activeDirs.has(entry)) continue;
    const dirPath = join(chunkedDir, entry);
    try {
      const info = await stat(dirPath);
      if (info.isDirectory() && Date.now() - info.mtimeMs > CHUNKED_UPLOAD_TTL_MS) {
        await rm(dirPath, { recursive: true, force: true });
        logger.info("Cleaned up orphaned chunked upload dir", { dir: entry });
      }
    } catch {
      // Ignore errors for individual entries
    }
  }
}

let cleanupIntervalId: ReturnType<typeof setInterval> | null = null;

/** Initialize chunked upload lifecycle — call from daemon startup. */
export function initChunkedUpload(): void {
  cleanupIntervalId = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);
  cleanupOrphanedTempDirs().catch((err) => {
    logger.warn("Failed to cleanup orphaned temp dirs", { error: stringifyError(err) });
  });
}

/** Shutdown chunked upload lifecycle — call from daemon shutdown. */
export function shutdownChunkedUpload(): void {
  if (cleanupIntervalId) {
    clearInterval(cleanupIntervalId);
    cleanupIntervalId = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────────────

const InitUploadBody = z.object({
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().positive().max(MAX_FILE_SIZE),
  chatId: z.string().optional(),
});

const ChunkParams = z.object({
  uploadId: z.string().uuid(),
  chunkIndex: z.coerce.number().int().nonnegative(),
});

const UploadIdParam = z.object({ uploadId: z.string().uuid() });

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

export const chunkedUploadApp = daemonFactory
  .createApp()

  /** Start a chunked upload session */
  .post("/init", zValidator("json", InitUploadBody), async (c) => {
    const { fileName, fileSize, chatId } = c.req.valid("json");

    if (!getValidatedMimeType(fileName)) {
      return c.json({ error: FILE_TYPE_NOT_ALLOWED_ERROR }, 415);
    }

    if (sessions.size >= MAX_CONCURRENT_SESSIONS) {
      return c.json({ error: "Too many concurrent uploads. Try again later." }, 429);
    }

    if (chatId && isInvalidChatId(chatId)) {
      return c.json({ error: "Invalid chatId" }, 400);
    }

    const uploadId = crypto.randomUUID();
    const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
    const tempDir = join(getAtlasHome(), "uploads", "chunked", uploadId);

    await mkdir(tempDir, { recursive: true });

    sessions.set(uploadId, {
      uploadId,
      fileName,
      fileSize,
      totalChunks,
      completedChunks: new Set(),
      chatId,
      tempDir,
      createdAt: Date.now(),
      status: "uploading",
    });

    logger.info("Chunked upload initiated", { uploadId, fileName, fileSize, totalChunks });
    return c.json({ uploadId, chunkSize: CHUNK_SIZE, totalChunks });
  })

  /** Upload a single chunk */
  .put("/:uploadId/chunk/:chunkIndex", zValidator("param", ChunkParams), async (c) => {
    const { uploadId, chunkIndex } = c.req.valid("param");

    const session = sessions.get(uploadId);
    if (!session) {
      return c.json({ error: "Upload session not found or expired" }, 404);
    }

    if (session.status !== "uploading") {
      return c.json({ error: `Upload is ${session.status}, cannot accept chunks` }, 409);
    }

    if (chunkIndex >= session.totalChunks) {
      return c.json({ error: `Invalid chunk index. Must be 0-${session.totalChunks - 1}` }, 400);
    }

    // Validate chunk size — all chunks must be <= CHUNK_SIZE
    const contentLength = Number(c.req.header("content-length") ?? -1);
    if (contentLength > CHUNK_SIZE) {
      return c.json(
        { error: `Chunk too large. Maximum size per chunk is ${CHUNK_SIZE} bytes` },
        413,
      );
    }

    // Idempotent: if chunk already received, skip writing
    if (session.completedChunks.has(chunkIndex)) {
      return c.json({ received: chunkIndex });
    }

    const body = c.req.raw.body;
    if (!body) {
      return c.json({ error: "Empty request body" }, 400);
    }

    const chunkPath = join(session.tempDir, `chunk-${chunkIndex}`);
    try {
      await streamToFile(body, chunkPath);

      // Verify actual written size to prevent Content-Length bypass
      const chunkStat = await stat(chunkPath);
      if (chunkStat.size > CHUNK_SIZE) {
        await rm(chunkPath, { force: true });
        return c.json({ error: "Chunk too large" }, 413);
      }

      session.completedChunks.add(chunkIndex);
      return c.json({ received: chunkIndex });
    } catch (error) {
      logger.error("Failed to write chunk", { uploadId, chunkIndex, error: stringifyError(error) });
      return c.json({ error: "Failed to write chunk" }, 500);
    }
  })

  /** Complete the upload — assemble chunks and create artifact */
  .post("/:uploadId/complete", zValidator("param", UploadIdParam), async (c) => {
    const { uploadId } = c.req.valid("param");

    const session = sessions.get(uploadId);
    if (!session) {
      return c.json({ error: "Upload session not found or expired" }, 404);
    }

    if (session.status !== "uploading") {
      return c.json({ error: `Upload is ${session.status}` }, 409);
    }

    for (let i = 0; i < session.totalChunks; i++) {
      if (!session.completedChunks.has(i)) {
        return c.json({ error: `Missing chunk ${i}. Upload all chunks before completing.` }, 400);
      }
    }

    session.status = "completing";

    const atlasHome = getAtlasHome();
    const subdir = session.chatId || "orphan";
    const uuid = crypto.randomUUID();
    const ext = extname(session.fileName) || ".txt";
    const assembledPath = join(atlasHome, "uploads", subdir, `${uuid}${ext}`);

    try {
      await mkdir(dirname(assembledPath), { recursive: true });

      const writeStream = createWriteStream(assembledPath);
      try {
        for (let i = 0; i < session.totalChunks; i++) {
          const chunkStream = createReadStream(join(session.tempDir, `chunk-${i}`));
          await pipeline(chunkStream, writeStream, { end: false });
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          writeStream.end((err?: Error | null) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }

      // Verify assembled file size matches declared size
      const assembled = await stat(assembledPath);
      if (assembled.size !== session.fileSize) {
        await rm(assembledPath, { force: true });
        cleanupSession(uploadId, session);
        return c.json(
          { error: `Size mismatch: expected ${session.fileSize} bytes, got ${assembled.size}` },
          400,
        );
      }

      const result = await createArtifactFromFile({
        filePath: assembledPath,
        fileName: session.fileName,
        chatId: session.chatId,
      });
      if (!result.ok) {
        cleanupSession(uploadId, session);
        return c.json({ error: result.error }, 500);
      }

      cleanupSession(uploadId, session);
      return c.json({ artifact: result.artifact }, 201);
    } catch (error) {
      logger.error("Failed to complete chunked upload", {
        uploadId,
        filename: session.fileName,
        error: stringifyError(error),
      });
      cleanupSession(uploadId, session);
      return c.json({ error: "Upload completion failed" }, 500);
    }
  })

  /** Get upload status — used by client to resume */
  .get("/:uploadId/status", zValidator("param", UploadIdParam), (c) => {
    const { uploadId } = c.req.valid("param");

    const session = sessions.get(uploadId);
    if (!session) {
      return c.json({ error: "Upload session not found or expired" }, 404);
    }

    return c.json({
      uploadId: session.uploadId,
      totalChunks: session.totalChunks,
      completedChunks: [...session.completedChunks].sort((a, b) => a - b),
      status: session.status,
    });
  });

/** @internal Exposed for tests only — clear all sessions without disk cleanup. */
export function _resetSessionsForTest(): void {
  sessions.clear();
}

/** @internal Exposed for tests only — get a session by uploadId. */
export function _getSessionForTest(uploadId: string): UploadSession | undefined {
  return sessions.get(uploadId);
}

/** @internal Exposed for tests only — run expired session cleanup. */
export const _cleanupExpiredSessionsForTest = cleanupExpiredSessions;

/** Remove session from map and delete temp directory */
function cleanupSession(uploadId: string, session: UploadSession): void {
  sessions.delete(uploadId);
  rm(session.tempDir, { recursive: true, force: true }).catch((err) => {
    logger.warn("Failed to cleanup chunked upload temp dir", {
      uploadId,
      tempDir: session.tempDir,
      error: stringifyError(err),
    });
  });
}

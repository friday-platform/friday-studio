/**
 * GET /api/logs/tail — reads ~/.atlas/logs/global.log from a byte offset,
 * parses JSONL, filters by level, returns structured entries with next_offset
 * for cursor-based pagination.
 *
 * The daemon process has --allow-read, so this endpoint enables sandboxed FSM
 * code actions (which have no fs access) to consume log data via ctx.http.fetch().
 */

import { Buffer } from "node:buffer";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@atlas/logger";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { validator } from "hono-openapi";
import { z } from "zod";
import { daemonFactory } from "../src/factory.ts";

// --- Zod Schemas ---

export const LogTailQuerySchema = z.object({
  since_offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(5000).default(500),
  level_filter: z.string().default("error,fatal"),
});

export const LogTailEntrySchema = z.object({
  timestamp: z.string(),
  level: z.string(),
  message: z.string(),
  component: z.string().optional(),
  error_name: z.string().optional(),
  stack_head: z.string().optional(),
});

export const LogTailResponseSchema = z.object({
  entries: z.array(LogTailEntrySchema),
  next_offset: z.number().int(),
  truncated: z.boolean(),
});

export type LogTailEntry = z.infer<typeof LogTailEntrySchema>;
export type LogTailResponse = z.infer<typeof LogTailResponseSchema>;

// --- Internal helpers ---

const LOG_FILE_NAME = "global.log";
const READ_CHUNK_SIZE = 1024 * 256; // 256 KB chunks

/**
 * Parse a single JSONL line from @atlas/logger output into a flattened LogTailEntry.
 * Returns undefined for malformed lines (skipped gracefully).
 */
export function parseLogLine(line: string): LogTailEntry | undefined {
  try {
    const raw: unknown = JSON.parse(line);
    if (typeof raw !== "object" || raw === null) return undefined;

    const obj = raw as Record<string, unknown>;
    const timestamp = typeof obj.timestamp === "string" ? obj.timestamp : "";
    const level = typeof obj.level === "string" ? obj.level : "";
    const message = typeof obj.message === "string" ? obj.message : "";

    // Flatten context fields
    const context =
      typeof obj.context === "object" && obj.context !== null
        ? (obj.context as Record<string, unknown>)
        : {};

    const component = typeof context.component === "string" ? context.component : undefined;

    // Extract error name from context.error
    let errorName: string | undefined;
    if (typeof context.error === "object" && context.error !== null) {
      const err = context.error as Record<string, unknown>;
      if (typeof err.name === "string") {
        errorName = err.name;
      } else if (typeof err.message === "string") {
        // Some errors store message but not name
        errorName = err.message.slice(0, 80);
      }
    } else if (typeof context.error === "string") {
      errorName = context.error.slice(0, 80);
    }

    // Extract stack head (first 3 lines)
    const stackTrace = typeof obj.stack_trace === "string" ? obj.stack_trace : undefined;
    const stackHead = stackTrace ? stackTrace.split("\n").slice(0, 3).join("\n") : undefined;

    return {
      timestamp,
      level,
      message,
      ...(component !== undefined ? { component } : {}),
      ...(errorName !== undefined ? { error_name: errorName } : {}),
      ...(stackHead !== undefined ? { stack_head: stackHead } : {}),
    };
  } catch {
    return undefined;
  }
}

// --- Route ---

const logsRoutes = daemonFactory.createApp();

logsRoutes.get("/tail", validator("query", LogTailQuerySchema), async (c) => {
  const { since_offset, limit, level_filter } = c.req.valid("query");
  const allowedLevels = new Set(level_filter.split(",").map((l) => l.trim().toLowerCase()));
  const logPath = join(getAtlasHome(), "logs", LOG_FILE_NAME);

  const emptyResponse: LogTailResponse = {
    entries: [],
    next_offset: since_offset,
    truncated: false,
  };

  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fileHandle = await open(logPath, "r");
  } catch {
    // Log file doesn't exist yet — return empty
    return c.json(emptyResponse);
  }

  try {
    const fileStat = await fileHandle.stat();
    const fileSize = fileStat.size;

    if (since_offset >= fileSize) {
      await fileHandle.close();
      return c.json({ ...emptyResponse, next_offset: fileSize });
    }

    const entries: LogTailEntry[] = [];
    let currentOffset = since_offset;
    let truncated = false;
    let remainder = "";

    while (currentOffset < fileSize && entries.length < limit) {
      const bytesToRead = Math.min(READ_CHUNK_SIZE, fileSize - currentOffset);
      const buffer = Buffer.alloc(bytesToRead);
      const { bytesRead } = await fileHandle.read(buffer, 0, bytesToRead, currentOffset);

      if (bytesRead === 0) break;

      const chunk = remainder + buffer.subarray(0, bytesRead).toString("utf-8");
      const lines = chunk.split("\n");

      // Last element may be incomplete — save as remainder
      remainder = lines.pop() ?? "";
      currentOffset += bytesRead;

      for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const trimmed = lines[lineIdx]?.trim() ?? "";
        if (trimmed.length === 0) continue;

        const parsed = parseLogLine(trimmed);
        if (!parsed) continue;

        if (!allowedLevels.has(parsed.level.toLowerCase())) continue;

        entries.push(parsed);
        if (entries.length >= limit) {
          // More data remains: unprocessed lines in batch, remainder, or more file bytes
          const hasMoreLines = lineIdx < lines.length - 1;
          truncated = hasMoreLines || remainder.length > 0 || currentOffset < fileSize;
          break;
        }
      }
    }

    // If we exhausted the file, account for any trailing remainder without a newline
    if (entries.length < limit && remainder.trim().length > 0) {
      const parsed = parseLogLine(remainder.trim());
      if (parsed && allowedLevels.has(parsed.level.toLowerCase())) {
        entries.push(parsed);
      }
    }

    // next_offset = where we stopped reading in the file
    const nextOffset = currentOffset;

    await fileHandle.close();

    const response: LogTailResponse = { entries, next_offset: nextOffset, truncated };

    return c.json(response);
  } catch (error: unknown) {
    if (fileHandle) {
      await fileHandle.close().catch(() => {});
    }
    logger.error("Failed to read log file", { error, path: logPath });
    return c.json({ error: "Failed to read log file" }, 500);
  }
});

export { logsRoutes };
export type LogsRoutes = typeof logsRoutes;

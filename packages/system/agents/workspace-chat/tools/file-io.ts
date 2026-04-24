/**
 * File I/O tools — `read_file`, `write_file`, `list_files` — all scoped to
 * a per-session ephemeral scratch directory.
 *
 * ## Why scratch-scoped, not workspace-scoped
 *
 * We want Friday to be able to:
 *
 *   1. Save a `web_fetch` response to a file so a subsequent `run_code`
 *      Python script can analyze it with pandas.
 *   2. Let the user download intermediate artifacts from a multi-step
 *      research session.
 *   3. Persist small pieces of state across tool calls within one turn.
 *
 * We explicitly do **NOT** want Friday to:
 *
 *   - Read arbitrary files on the operator's machine (`~/.ssh/id_rsa`, …).
 *   - Write to workspace source code or config.
 *   - Leak data across users or across chat sessions.
 *
 * So every path is resolved relative to `{ATLAS_HOME}/scratch/{sessionId}/`
 * and rejected if it escapes that root after `path.resolve` normalization.
 * The same scratch dir is shared with {@link createRunCodeTool}, so a
 * Python script and a `read_file` call see the same files.
 *
 * This matches OpenClaw's "workspace-scoped exec" pattern and Hermes'
 * sandbox file-permission model in spirit, minus the Docker / UDS RPC
 * infrastructure — a cheaper, trust-local-code approach.
 *
 * @module
 */

import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import type { AtlasTools } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_READ_BYTES = 256 * 1024; // 256 KB
const MAX_WRITE_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_LIST_ENTRIES = 1000;

// ─── Scratch path resolver ───────────────────────────────────────────────────

function scratchRoot(sessionId: string): string {
  const atlasHome = process.env.ATLAS_HOME ?? join(process.env.HOME ?? "/tmp", ".atlas");
  const safe = sessionId.replace(/[^a-zA-Z0-9-_]/g, "");
  return join(atlasHome, "scratch", safe || "default");
}

/**
 * Resolve `requestedPath` relative to the session scratch dir. If the
 * resolved absolute path escapes the scratch root (via `..`, an absolute
 * path, or a symlink target outside the root) we reject with an error.
 */
function resolveInScratch(
  sessionId: string,
  requestedPath: string,
): { ok: true; absolute: string } | { ok: false; error: string } {
  const root = scratchRoot(sessionId);

  // Absolute paths are rejected outright to avoid any chance of escape.
  if (isAbsolute(requestedPath)) {
    return {
      ok: false,
      error: `path must be relative to the scratch dir, not absolute: ${requestedPath}`,
    };
  }

  const absolute = resolve(root, requestedPath);
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { ok: false, error: `path escapes scratch dir: ${requestedPath}` };
  }
  return { ok: true, absolute };
}

// ─── Input schemas ───────────────────────────────────────────────────────────

const ReadFileInput = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "Relative path inside the session scratch dir. Absolute paths and `..` escapes are rejected.",
    ),
  max_bytes: z
    .number()
    .int()
    .min(1)
    .max(MAX_READ_BYTES)
    .optional()
    .describe(`Maximum bytes to read. Default and max ${MAX_READ_BYTES}.`),
});

const WriteFileInput = z.object({
  path: z.string().min(1).describe("Relative path inside the session scratch dir."),
  content: z
    .string()
    .max(MAX_WRITE_BYTES)
    .describe(
      `UTF-8 text to write. Overwrites any existing file. Max ${MAX_WRITE_BYTES} bytes (${Math.round(MAX_WRITE_BYTES / 1024 / 1024)} MB).`,
    ),
});

const ListFilesInput = z.object({
  path: z
    .string()
    .optional()
    .describe("Optional relative subdirectory to list. Defaults to the scratch root."),
});

// ─── Tool factory ────────────────────────────────────────────────────────────

interface FileOk {
  ok: true;
}
interface FileErr {
  error: string;
}

export interface ReadFileSuccess {
  path: string;
  content: string;
  size_bytes: number;
  truncated: boolean;
}

export interface WriteFileSuccess extends FileOk {
  path: string;
  bytes_written: number;
}

export interface ListFilesSuccess {
  path: string;
  entries: Array<{ name: string; type: "file" | "directory"; size_bytes: number }>;
  truncated: boolean;
}

/**
 * Build the file-io tool set. All three tools share the same session-scoped
 * scratch dir so they compose with {@link createRunCodeTool}: a Python
 * script's output written via `run_code` can be `read_file`'d in the next
 * turn, and vice versa.
 */
export function createFileIOTools(sessionId: string, logger: Logger): AtlasTools {
  return {
    read_file: tool({
      description:
        "Read a text file from the session scratch directory. Scoped to the per-session ephemeral dir — paths are relative, absolute paths and `..` escapes are rejected. Use this to read files written by `run_code`, `web_fetch`, or earlier `write_file` calls within the same conversation.",
      inputSchema: ReadFileInput,
      execute: async ({ path, max_bytes }): Promise<ReadFileSuccess | FileErr> => {
        const resolved = resolveInScratch(sessionId, path);
        if (!resolved.ok) return { error: resolved.error };
        try {
          const stats = await stat(resolved.absolute);
          if (!stats.isFile()) {
            return { error: `not a regular file: ${path}` };
          }
          const cap = max_bytes ?? MAX_READ_BYTES;
          const buffer = await readFile(resolved.absolute);
          const truncated = buffer.byteLength > cap;
          const slice = truncated ? buffer.subarray(0, cap) : buffer;
          const content = new TextDecoder().decode(slice);
          logger.info("read_file success", { sessionId, path, bytes: buffer.byteLength });
          return { path, content, size_bytes: buffer.byteLength, truncated };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: `read_file failed: ${message}` };
        }
      },
    }),

    write_file: tool({
      description:
        "Write UTF-8 text to a file in the session scratch directory. Overwrites any existing file at the same path. Use this to stage intermediate data for a later `run_code` call or to save the LLM's generated content for the user to retrieve.",
      inputSchema: WriteFileInput,
      execute: async ({ path, content }): Promise<WriteFileSuccess | FileErr> => {
        const resolved = resolveInScratch(sessionId, path);
        if (!resolved.ok) return { error: resolved.error };
        try {
          // Ensure parent dir exists.
          const { dirname } = await import("node:path");
          const { mkdir } = await import("node:fs/promises");
          await mkdir(dirname(resolved.absolute), { recursive: true });
          await writeFile(resolved.absolute, content, "utf-8");
          const bytes = new TextEncoder().encode(content).byteLength;
          logger.info("write_file success", { sessionId, path, bytes });
          return { ok: true, path, bytes_written: bytes };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { error: `write_file failed: ${message}` };
        }
      },
    }),

    list_files: tool({
      description:
        "List entries in the session scratch directory. Returns up to 1000 entries with name, type (file | directory), and size. Use this to discover what files are available after a `run_code` call has produced output you want to read.",
      inputSchema: ListFilesInput,
      execute: async ({ path }): Promise<ListFilesSuccess | FileErr> => {
        const requested = path ?? ".";
        const resolved = resolveInScratch(sessionId, requested);
        if (!resolved.ok) return { error: resolved.error };
        try {
          const dirents = await readdir(resolved.absolute, { withFileTypes: true });
          const sliced = dirents.slice(0, MAX_LIST_ENTRIES);
          const entries = await Promise.all(
            sliced.map(async (dirent) => {
              const type: "file" | "directory" = dirent.isDirectory() ? "directory" : "file";
              let sizeBytes = 0;
              if (type === "file") {
                try {
                  const stats = await stat(join(resolved.absolute, dirent.name));
                  sizeBytes = stats.size;
                } catch {
                  sizeBytes = 0;
                }
              }
              return { name: dirent.name, type, size_bytes: sizeBytes };
            }),
          );
          return { path: requested, entries, truncated: dirents.length > MAX_LIST_ENTRIES };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("ENOENT")) {
            return { path: requested, entries: [], truncated: false };
          }
          return { error: `list_files failed: ${message}` };
        }
      },
    }),
  };
}

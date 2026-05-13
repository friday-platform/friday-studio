/**
 * `POST /api/scratch/upload` — write a file the user dropped on the chat
 * input directly to `{FRIDAY_HOME}/scratch/uploads/{chatId}/{filename}` and
 * return its absolute path.
 *
 * Rationale (PR #292 v5): the prior design stored attachments as full
 * artifacts (JetStream Object Store + KV metadata + library entry).
 * Ken's concern: every chat drop ends up polluting the artifact library.
 * Browser drag-drop doesn't expose the original OS path (verified — Chrome
 * 2026 strips `text/uri-list` / `text/plain` / `DownloadURL` for native
 * drops), so we can't honour the "agent reads from `~/Downloads/foo.csv`"
 * vision either. The compromise: write bytes to the per-chat scratch dir
 * on disk, hand the agent a real filesystem path, never touch the artifact
 * system.
 */

import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import {
  FILE_TYPE_NOT_ALLOWED_ERROR,
  getValidatedMimeType,
  inferMimeFromFilename,
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
import { createLogger } from "@atlas/logger";
import { getFridayHome } from "@atlas/utils/paths.server";
import { daemonFactory } from "../src/factory.ts";
import { requireWorkspaceMember } from "../src/workspace-authz.ts";

const logger = createLogger({ name: "scratch-upload" });

/**
 * Per-chat scratch uploads root. Adding a tier under `scratch/uploads/`
 * (alongside the existing `scratch/{sessionId}/` tools-scratch dirs)
 * keeps lifecycles separate — session-scratch belongs to the agent's
 * `run_code` / `write_file` tools and is GC'd by session-end; the
 * uploads tier belongs to the chat as a whole and survives across
 * the chat's sessions.
 */
export function uploadsRoot(chatId: string): string {
  return join(getFridayHome(), "scratch", "uploads", chatId);
}

/**
 * Sanitize a user-supplied filename so it can't escape the chat's uploads
 * directory. Keep just the basename, reject names with `..` segments or
 * NUL bytes (defense-in-depth — `basename` on POSIX already strips
 * separators). Returns `null` on rejection so the caller can surface 400.
 */
function safeFilename(raw: string): string | null {
  if (raw.length === 0) return null;
  if (raw.includes("\0")) return null;
  const base = basename(raw);
  if (base !== raw) return null; // contained a path separator
  if (base === "" || base === "." || base === "..") return null;
  if (base.includes("..")) return null;
  return base;
}

/**
 * Resolve `filename` inside the chat's uploads dir and verify the result
 * stays under the root. Symlinks aren't followed (mkdir/writeFile operate
 * on the literal path); any further sneaking would have to come from
 * filesystem state the daemon process planted itself.
 */
function resolveInUploads(
  chatId: string,
  filename: string,
): { ok: true; root: string; absolute: string } | { ok: false; error: string } {
  const root = uploadsRoot(chatId);
  const absolute = resolve(root, filename);
  if (absolute !== join(root, filename)) {
    return { ok: false, error: "filename failed path-resolution invariant" };
  }
  if (!absolute.startsWith(root + sep) && absolute !== root) {
    return { ok: false, error: "filename escapes uploads root" };
  }
  return { ok: true, root, absolute };
}

const scratchUploadApp = daemonFactory.createApp().post("/upload", async (c) => {
  const contentType = c.req.header("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return c.json({ error: "Content-Type must be multipart/form-data" }, 400);
  }

  const formData = await c.req.formData();
  const file = formData.get("file");
  const chatId = formData.get("chatId")?.toString() ?? "";
  const workspaceId = formData.get("workspaceId")?.toString() ?? "";

  if (!(file instanceof File)) {
    return c.json({ error: "file field is required and must be a File" }, 400);
  }
  if (!chatId || isInvalidChatId(chatId)) {
    return c.json({ error: "Invalid chatId" }, 400);
  }
  if (!workspaceId || isInvalidChatId(workspaceId)) {
    return c.json({ error: "Invalid workspaceId" }, 400);
  }
  // Auth gate — only members of the chat's workspace can upload. Mirrors
  // the artifact-upload route precedent at `routes/artifacts.ts:964`.
  await requireWorkspaceMember(c, workspaceId);

  // Same legacy-format rejection as the artifact route — surfaces the
  // .doc → .docx hint.
  const ext = extname(file.name).toLowerCase();
  const legacyError = LEGACY_FORMAT_ERRORS.get(ext);
  if (legacyError) {
    return c.json({ error: legacyError }, 415);
  }

  // Same mime allowlist as the artifact route. `getValidatedMimeType`
  // only returns the mime for uploadable extensions (per
  // `EXTENSION_TO_MIME`); anything else is refused.
  const mimeType = getValidatedMimeType(file.name) ?? inferMimeFromFilename(file.name);
  if (!mimeType) {
    return c.json({ error: FILE_TYPE_NOT_ALLOWED_ERROR }, 415);
  }
  // Specifically refuse SVG even when it slipped through the extension
  // map — the chat input also rejects client-side, but the server gate
  // is the load-bearing one.
  if (mimeType === "image/svg+xml") {
    return c.json({ error: FILE_TYPE_NOT_ALLOWED_ERROR }, 415);
  }

  // Same size limits as the artifact route (DRY across both upload paths).
  if (ext === ".pdf" && file.size > MAX_PDF_SIZE) {
    return c.json(
      { error: `PDF too large (max ${Math.round(MAX_PDF_SIZE / 1024 / 1024)}MB)` },
      413,
    );
  }
  if ((ext === ".docx" || ext === ".pptx") && file.size > MAX_OFFICE_SIZE) {
    return c.json(
      {
        error: `${ext.slice(1).toUpperCase()} too large (max ${Math.round(MAX_OFFICE_SIZE / 1024 / 1024)}MB)`,
      },
      413,
    );
  }
  if (isImageMimeType(mimeType) && file.size > MAX_IMAGE_SIZE) {
    return c.json({ error: "Image files must be under 5MB." }, 413);
  }
  if (isAudioMimeType(mimeType) && file.size > MAX_AUDIO_SIZE) {
    return c.json(
      { error: `Audio files must be under ${Math.round(MAX_AUDIO_SIZE / 1024 / 1024)}MB.` },
      413,
    );
  }
  if (file.size > MAX_FILE_SIZE) {
    return c.json(
      { error: `File too large (max ${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MB)` },
      413,
    );
  }

  // The display name (sanitized original) flows back in the response so the
  // UI bubble and the `<attachment filename="…">` tag the adapter splices
  // both show the human-readable filename. The on-disk name is content-
  // addressed — see below.
  const safe = safeFilename(file.name);
  if (!safe) {
    return c.json({ error: "Invalid filename" }, 400);
  }

  // Content-addressed storage: write to `{chatId}/{md5(bytes)}`, NOT the
  // user-supplied filename. Two wins:
  //   1. Identical bytes uploaded twice produce the same path → free dedup,
  //      no `data (2).csv`-style collisions, no overwrite races.
  //   2. The on-disk filename carries zero attacker-controlled characters,
  //      so the path-traversal gate's job collapses to a prefix check —
  //      adversarial filenames can't reach the filesystem.
  // MD5 is fine here: the security boundary is the resolver, not the hash.
  // Collisions are content collisions, which read back identical bytes —
  // benign.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const md5 = createHash("md5").update(bytes).digest("hex");
  const resolved = resolveInUploads(chatId, md5);
  if (!resolved.ok) {
    return c.json({ error: resolved.error }, 400);
  }

  try {
    await mkdir(resolved.root, { recursive: true });
    await writeFile(resolved.absolute, bytes);
    const persisted = await stat(resolved.absolute);
    logger.info("scratch_upload success", {
      chatId,
      workspaceId,
      filename: safe,
      md5,
      size: persisted.size,
      mimeType,
    });
    return c.json(
      { path: resolved.absolute, filename: safe, mediaType: mimeType, size: persisted.size },
      201,
    );
  } catch (err) {
    logger.error("scratch_upload failed", {
      chatId,
      workspaceId,
      filename: safe,
      md5,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "Upload failed" }, 500);
  }
});

export { scratchUploadApp };

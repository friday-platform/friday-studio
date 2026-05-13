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

import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  FILE_TYPE_NOT_ALLOWED_ERROR,
  getValidatedMimeType,
  inferMimeFromFilename,
  isAudioMimeType,
  isImageMimeType,
  isInvalidChatId,
  LEGACY_FORMAT_ERRORS,
  MAX_AUDIO_SIZE,
  MAX_IMAGE_SIZE,
  MAX_OFFICE_SIZE,
  MAX_PDF_SIZE,
} from "@atlas/core/artifacts/file-upload";
import { ChatStorage } from "@atlas/core/chat/storage";
import { UserStorage } from "@atlas/core/users/storage";
import { createLogger } from "@atlas/logger";
import { chatUploadsRoot } from "@atlas/utils/paths.server";
import { daemonFactory } from "../src/factory.ts";
import { requireWorkspaceMember } from "../src/workspace-authz.ts";

const logger = createLogger({ name: "scratch-upload" });

/**
 * Route-specific size cap. Distinct from `MAX_FILE_SIZE` (500MB) on the
 * artifact route — that one streams to JetStream Object Store and can
 * tolerate the bigger ceiling. Chat-input attachments are typically
 * small (CSVs, MDs, configs) and 25MB is generous; the lower cap also
 * bounds the per-upload heap profile of the multipart body that Hono
 * buffers before exposing `file`.
 */
const MAX_SCRATCH_UPLOAD_SIZE = 25 * 1024 * 1024;

/**
 * Sanitize a user-supplied filename so it survives JSON round-tripping
 * and rendering. The filename never reaches the filesystem (on-disk
 * names are md5 hashes), but it does flow back to the client as the
 * display name and into the `<attachment>` chip — so we still reject
 * obviously broken inputs (NUL bytes, paths, dot-prefix names).
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

  // chatId↔workspaceId binding. Closes the cross-tenant write primitive:
  // without this, any authenticated member of *some* workspace could
  // POST `?workspaceId=<theirs>&chatId=<foreign>` and write bytes into
  // a chat that belongs to a different workspace. `getChat` lives in
  // the workspace-scoped namespace — a chat in another workspace
  // returns null here.
  //
  // Lifecycle wrinkle: chats are created lazily on the first message
  // (via `chat-sdk-state-adapter.subscribe()`), but the user can drop a
  // file BEFORE typing — so the chat record doesn't exist yet on the
  // first upload. We create it idempotently here. Safety: createChat is
  // workspace-scoped, and the caller already passed
  // `requireWorkspaceMember(workspaceId)` — so the chat ends up owned
  // by THIS user in THIS workspace. An attacker who races a victim for
  // a chatId would create their own (empty) chat record under their
  // own workspace; the victim's eventual subscribe() against a
  // different workspaceId still works because the namespace key is
  // (workspaceId, chatId). chatIds are 12-char UUIDs so collisions are
  // negligible.
  const userId = c.get("userId") ?? UserStorage.getCachedLocalUserId();
  const chatLookup = await ChatStorage.getChat(chatId, workspaceId);
  if (!chatLookup.ok) {
    return c.json({ error: chatLookup.error }, 500);
  }
  if (!chatLookup.data) {
    const created = await ChatStorage.createChat({ chatId, userId, workspaceId, source: "atlas" });
    if (!created.ok) {
      return c.json({ error: `chat-create failed: ${created.error}` }, 500);
    }
  }

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
  if (file.size > MAX_SCRATCH_UPLOAD_SIZE) {
    return c.json(
      { error: `File too large (max ${Math.round(MAX_SCRATCH_UPLOAD_SIZE / 1024 / 1024)}MB)` },
      413,
    );
  }

  // Display name (sanitized original) flows back in the response so the
  // UI bubble shows the human-readable filename in the chip. The on-disk
  // name is the md5 of the bytes — adversarial filenames physically
  // cannot reach the filesystem.
  const safe = safeFilename(file.name);
  if (!safe) {
    return c.json({ error: "Invalid filename" }, 400);
  }

  // Stream the upload through a hash + write pipeline so we never hold
  // the whole file in heap. Sequence:
  //   1. Write bytes to a per-request tempfile (.tmp-{uuid}) under the
  //      chat's uploads dir.
  //   2. Compute md5 incrementally as bytes flow past.
  //   3. atomic-rename tmp → `{chatId}/{md5}`.
  // Failures clean up the tempfile.
  //
  // Why content-addressed: identical bytes uploaded twice produce the
  // same path → free dedup, no `data (2).csv` collisions, the on-disk
  // filename carries zero attacker-controlled characters so the path-
  // traversal gate's job collapses to a prefix check. MD5 is fine here:
  // the security boundary is the resolver, not the hash. Adversarial
  // collisions read back identical bytes — benign.
  const root = chatUploadsRoot(chatId);
  await mkdir(root, { recursive: true });
  const tmpPath = join(root, `.tmp-${randomUUID()}`);
  const hash = createHash("md5");
  let bytesWritten = 0;
  try {
    await pipeline(
      // file.stream() is a Web ReadableStream; convert to Node Readable.
      // `Readable.fromWeb` requires the source to be a `ReadableStream`,
      // which it is per the Fetch spec — the `as never` is a deno-check
      // workaround because the daemon's TS lib doesn't always pull in
      // dom.ReadableStream typings.
      Readable.fromWeb(file.stream() as never),
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          hash.update(chunk);
          bytesWritten += chunk.byteLength;
          yield chunk;
        }
      },
      createWriteStream(tmpPath),
    );
    const md5 = hash.digest("hex");
    const finalPath = join(root, md5);
    await rename(tmpPath, finalPath);
    const persisted = await stat(finalPath);
    logger.info("scratch_upload success", {
      chatId,
      workspaceId,
      filename: safe,
      md5,
      size: persisted.size,
      mimeType,
    });
    return c.json(
      { path: finalPath, filename: safe, mediaType: mimeType, size: persisted.size },
      201,
    );
  } catch (err) {
    // Best-effort tempfile cleanup. A failed upload that leaves a
    // `.tmp-{uuid}` behind is benign (no other path references it) but
    // we clean up anyway to keep the dir tidy.
    await rm(tmpPath, { force: true }).catch(() => {});
    logger.error("scratch_upload failed", {
      chatId,
      workspaceId,
      filename: safe,
      bytesWritten,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "Upload failed" }, 500);
  }
});

export { scratchUploadApp };

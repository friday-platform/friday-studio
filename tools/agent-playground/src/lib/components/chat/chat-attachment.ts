/**
 * Chat attachment helpers shared between `chat-input.svelte` (the input row's
 * own drop target) and `user-chat.svelte` (the surrounding chat area's drop
 * overlay). Both components run the same classification + upload pipeline;
 * extracting it here keeps the two from drifting on the next change.
 *
 * @module
 */

import {
  ACCEPTED_TYPES_DESCRIPTION,
  inferMimeFromFilename,
  isTextMimeType,
} from "@atlas/core/artifacts/file-upload";
// `$lib/` is a SvelteKit alias Vite resolves but `deno check` (CI's
// type-check job) does not — use a relative path so both toolchains agree.
import { uploadFileToScratch } from "../../upload.ts";

/**
 * Image attachment: rendered inline in the user bubble and shipped to the
 * model as a `type: "file"` UI message part (data URL). Stays on the inline
 * path so the model gets the bytes as a vision input without a tool roundtrip.
 */
export interface ImageAttachment {
  kind: "image";
  id: string;
  file: File;
  dataUrl: string;
}

/**
 * File attachment: any non-image file the user dropped. Uploaded to
 * `/api/scratch/upload` on drop, which writes the bytes to
 * `{FRIDAY_HOME}/scratch/uploads/{chatId}/{filename}` and returns the
 * absolute path. The chip shows progress while in flight. On submit, the
 * resolved `path` lands in a `data-file-attached` message part — the
 * agent reads from that path via the `read_attachment` tool. No artifact
 * storage, no library entry.
 */
export interface FileAttachment {
  kind: "file";
  id: string;
  file: File;
  /** Inferred or browser-reported mime — surfaced on the pending chip. */
  mediaType: string;
  status: "uploading" | "ready" | "error";
  /** Bytes uploaded so far. Together with file.size yields percentage. */
  progress: number;
  /** Absolute path on the daemon's filesystem, set once upload resolves. */
  path?: string;
  errorMessage?: string;
  /** Abort handle — wired to the chip's ✕ so cancel actually cancels. */
  abortController: AbortController;
}

export type ChatAttachment = ImageAttachment | FileAttachment;

/**
 * Decide whether a dropped/picked file goes through the inline-image path
 * or the artifact-upload path. Returns `null` for files we don't accept.
 *
 * The classification walks both `file.type` (browser-reported MIME) and a
 * fallback inferred from the filename extension — browsers report empty
 * `file.type` for many text formats on Linux/Windows.
 */
/**
 * Identify SVG files so the caller can refuse them with a specific reason
 * (vs the generic "unsupported" path). Inline SVG can carry `<script>` tags;
 * the chat's image-render surface (`<img>`) doesn't execute them, but defense-
 * in-depth is cheap here. Agents can still emit SVG artifacts via
 * `create_artifact` — those render inside the sandboxed iframe.
 */
function isSvg(file: File): boolean {
  return file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
}

export function classifyAttachment(file: File): "image" | "file" | null {
  if (isSvg(file)) return null;
  if (file.type.startsWith("image/")) return "image";
  const inferred = inferMimeFromFilename(file.name);
  if (inferred?.startsWith("image/")) return "image";
  // Any other inferable mime → artifact upload path. The server's
  // upload route validates mime + magic bytes; this only gates which
  // client path we route the file down.
  if (inferred !== undefined) return "file";
  // Some text-mime files won't match an extension we recognize (e.g.
  // `.todo`, `.notes`). If the browser reported a text mime, treat as
  // artifact too — the server's magic-byte sniff has the final say.
  if (file.type && isTextMimeType(file.type)) return "file";
  return null;
}

/**
 * Human-readable reason a file was refused. Call only when
 * `classifyAttachment(file)` returned `null` — drives the chat-input's
 * "couldn't attach" toast so the user gets feedback instead of staring
 * at a drop zone that ate their file.
 */
export function rejectionReason(file: File): string {
  if (isSvg(file)) {
    return `SVG attachments aren't supported on the chat input (script-injection risk). Ask the agent to create one for you instead.`;
  }
  return `"${file.name}" isn't a supported file type. Supported: ${ACCEPTED_TYPES_DESCRIPTION}.`;
}

/**
 * Compose a single toast summary for multiple rejected files. Avoids the
 * "drop 50 files → 50 stacked toasts" failure mode. Falls back to the
 * single-file `rejectionReason` when only one file was refused so the
 * specific reason (e.g. SVG script-injection) still surfaces.
 */
export function rejectionToast(rejected: readonly File[]):
  | { title: string; description: string }
  | null {
  if (rejected.length === 0) return null;
  if (rejected.length === 1) {
    const file = rejected[0];
    if (!file) return null;
    return { title: "Couldn't attach file", description: rejectionReason(file) };
  }
  const names = rejected.map((f) => `"${f.name}"`).join(", ");
  return {
    title: `Couldn't attach ${rejected.length} files`,
    description: `Refused: ${names}. Supported: ${ACCEPTED_TYPES_DESCRIPTION}.`,
  };
}

/**
 * Detect a content-duplicate among existing chips.
 *
 * Content-equivalence is what we actually care about (drag-drop the
 * same bytes twice → recognize it). The server already computes md5
 * over the bytes and returns the path as `{chatId}/{md5}`, so two
 * uploads of identical bytes produce identical paths. We lean on that
 * — no second hash compute on the client.
 *
 * - **File attachments** dedup by the server-returned `path`. Until
 *   the upload completes (`path === undefined`) the chip can't be
 *   matched against — that's the trade-off: we add the chip first,
 *   start the upload, and reconcile post-completion in
 *   `patchAttachment` (see `chat-input.svelte` / `user-chat.svelte`).
 *   A duplicate-drop briefly shows two chips before the second
 *   collapses with a toast. Acceptable UX given how rare the case is.
 *
 * - **Image attachments** dedup by `dataUrl` equality. Images don't
 *   go through the server upload path — they ride inline as data URLs
 *   on the message. Two drops of the same image produce identical
 *   data URLs (deterministic base64 of the same bytes); string
 *   equality is cheap and exact.
 */
export function isDuplicateAttachment(
  candidate: { kind: "image"; dataUrl: string } | { kind: "file"; path: string },
  existing: readonly ChatAttachment[],
): boolean {
  if (candidate.kind === "image") {
    return existing.some((att) => att.kind === "image" && att.dataUrl === candidate.dataUrl);
  }
  return existing.some((att) => att.kind === "file" && att.path === candidate.path);
}

/**
 * Compose a single toast summary for files refused because they're
 * already attached. Same shape as `rejectionToast` so the call sites
 * can drop it in alongside.
 */
export function duplicateToast(
  duplicates: readonly File[],
): { title: string; description: string } | null {
  if (duplicates.length === 0) return null;
  if (duplicates.length === 1) {
    const file = duplicates[0];
    if (!file) return null;
    return {
      title: "Already attached",
      description: `"${file.name}" is already in the input — drop the existing chip first to re-attach.`,
    };
  }
  const names = duplicates.map((f) => `"${f.name}"`).join(", ");
  return {
    title: `${duplicates.length} files already attached`,
    description: `Skipped: ${names}.`,
  };
}

/**
 * Construct the initial `FileAttachment` shape for a dropped file. The
 * caller appends this to its `$state` array, then calls
 * {@link runFileUpload} with an `onUpdate` callback so per-progress and
 * terminal-state mutations land back on the same entry.
 */
export function buildFileAttachment(file: File): FileAttachment {
  const mediaType =
    file.type || inferMimeFromFilename(file.name) || "application/octet-stream";
  return {
    kind: "file",
    id: crypto.randomUUID(),
    file,
    mediaType,
    status: "uploading",
    progress: 0,
    abortController: new AbortController(),
  };
}

/**
 * Kick off the scratch upload for a `FileAttachment` and call
 * `onUpdate(id, patch)` with progress and terminal-state patches. The caller
 * owns the `$state` array — this helper is pure (no Svelte runes), so it
 * can be unit-tested without a component harness.
 *
 * Aborted uploads (`abortController.abort()`) short-circuit silently — no
 * patch is emitted, which lets the caller drop the entry from its list
 * without a race with a late `status: "error"` update.
 */
export function runFileUpload(opts: {
  att: FileAttachment;
  chatId: string;
  workspaceId: string;
  onUpdate: (id: string, patch: Partial<FileAttachment>) => void;
}): void {
  const { att, chatId, workspaceId, onUpdate } = opts;
  void uploadFileToScratch(att.file, {
    chatId,
    workspaceId,
    onProgress: (loaded) => onUpdate(att.id, { progress: loaded }),
    abortSignal: att.abortController.signal,
  }).then((result) => {
    if (att.abortController.signal.aborted) return;
    if ("path" in result) {
      onUpdate(att.id, {
        status: "ready",
        progress: att.file.size,
        path: result.path,
      });
    } else if (result.error !== "Upload cancelled") {
      onUpdate(att.id, { status: "error", errorMessage: result.error });
    }
  });
}

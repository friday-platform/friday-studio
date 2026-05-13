/**
 * Chat attachment helpers shared between `chat-input.svelte` (the input row's
 * own drop target) and `user-chat.svelte` (the surrounding chat area's drop
 * overlay). Both components run the same classification + upload pipeline;
 * extracting it here keeps the two from drifting on the next change.
 *
 * @module
 */

import { inferMimeFromFilename, isTextMimeType } from "@atlas/core/artifacts/file-upload";
import { uploadFile } from "$lib/upload.ts";

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
 * Artifact attachment: any non-image file the user dropped. Uploaded to
 * `/api/artifacts/upload` on drop; the chip shows progress while in flight.
 * On submit, the resolved `artifactId` lands in a `data-artifact-attached`
 * message part so the user bubble renders an `ArtifactCard` (same component
 * agent-produced CSV/JSON/PDF previews use). The chat handler expands the
 * artifact's bytes back into the model prompt server-side.
 */
export interface ArtifactAttachment {
  kind: "artifact";
  id: string;
  file: File;
  /** Inferred or browser-reported mime — surfaced on the pending chip. */
  mediaType: string;
  status: "uploading" | "ready" | "error";
  /** Bytes uploaded so far. Together with file.size yields percentage. */
  progress: number;
  /** Set once the upload resolves. The submit handler attaches this id. */
  artifactId?: string;
  errorMessage?: string;
  /** Abort handle — wired to the chip's ✕ so cancel actually cancels. */
  abortController: AbortController;
}

export type ChatAttachment = ImageAttachment | ArtifactAttachment;

/**
 * Decide whether a dropped/picked file goes through the inline-image path
 * or the artifact-upload path. Returns `null` for files we don't accept.
 *
 * The classification walks both `file.type` (browser-reported MIME) and a
 * fallback inferred from the filename extension — browsers report empty
 * `file.type` for many text formats on Linux/Windows.
 */
export function classifyAttachment(file: File): "image" | "artifact" | null {
  if (file.type.startsWith("image/")) return "image";
  const inferred = inferMimeFromFilename(file.name);
  if (inferred?.startsWith("image/")) return "image";
  // Any other inferable mime → artifact upload path. The server's
  // upload route validates mime + magic bytes; this only gates which
  // client path we route the file down.
  if (inferred !== undefined) return "artifact";
  // Some text-mime files won't match an extension we recognize (e.g.
  // `.todo`, `.notes`). If the browser reported a text mime, treat as
  // artifact too — the server's magic-byte sniff has the final say.
  if (file.type && isTextMimeType(file.type)) return "artifact";
  return null;
}

/**
 * Construct the initial `ArtifactAttachment` shape for a dropped file. The
 * caller appends this to its `$state` array, then calls
 * {@link runArtifactUpload} with an `onUpdate` callback so per-progress and
 * terminal-state mutations land back on the same entry.
 */
export function buildArtifactAttachment(file: File): ArtifactAttachment {
  const mediaType =
    file.type || inferMimeFromFilename(file.name) || "application/octet-stream";
  return {
    kind: "artifact",
    id: crypto.randomUUID(),
    file,
    mediaType,
    status: "uploading",
    progress: 0,
    abortController: new AbortController(),
  };
}

/**
 * Kick off the actual artifact upload for an `ArtifactAttachment` and call
 * `onUpdate(id, patch)` with progress and terminal-state patches. The caller
 * owns the `$state` array — this helper is pure (no Svelte runes), so it
 * can be unit-tested without a component harness.
 *
 * Aborted uploads (`abortController.abort()`) short-circuit silently — no
 * patch is emitted, which lets the caller drop the entry from its list
 * without a race with a late `status: "error"` update.
 */
export function runArtifactUpload(opts: {
  att: ArtifactAttachment;
  workspaceId: string;
  onUpdate: (id: string, patch: Partial<ArtifactAttachment>) => void;
}): void {
  const { att, workspaceId, onUpdate } = opts;
  void uploadFile(
    att.file,
    (loaded) => onUpdate(att.id, { progress: loaded }),
    att.abortController.signal,
    undefined,
    workspaceId,
  ).then((result) => {
    if (att.abortController.signal.aborted) return;
    if ("artifactId" in result) {
      onUpdate(att.id, {
        status: "ready",
        progress: att.file.size,
        artifactId: result.artifactId,
      });
    } else if (result.error !== "Upload cancelled") {
      onUpdate(att.id, { status: "error", errorMessage: result.error });
    }
  });
}

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
import { uploadFile } from "../../upload.ts";

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

export function classifyAttachment(file: File): "image" | "artifact" | null {
  if (isSvg(file)) return null;
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

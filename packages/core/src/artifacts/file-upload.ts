/**
 * File upload constants and validation utilities.
 * Single source of truth for MIME types, extensions, and size limits.
 * Used by both server (validation) and client (UX feedback).
 */

export const MAX_FILE_SIZE = 500 * 1024 * 1024;

// Lower than general limit due to memory usage during extraction
export const MAX_PDF_SIZE = 50 * 1024 * 1024;
export const MAX_OFFICE_SIZE = 50 * 1024 * 1024;

// Matches Anthropic API per-image limit
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

// Matches OpenAI Whisper API limit
export const MAX_AUDIO_SIZE = 25 * 1024 * 1024;

export const MAX_DECOMPRESSED_SIZE = 200 * 1024 * 1024;

/**
 * Error messages for legacy Office formats that require conversion before upload.
 * Used by both artifacts.ts and chunked-upload.ts routes.
 * Map avoids `in` operator matching inherited Object.prototype properties.
 */
export const LEGACY_FORMAT_ERRORS = new Map([
  [".doc", "Legacy .doc format not supported. Save as .docx and re-upload."],
  [".ppt", "Legacy .ppt format not supported. Save as .pptx and re-upload."],
]);

/**
 * Extension to MIME type mapping for allowed file types.
 *
 * Covers text formats (CSV, JSON, TXT, MD, YAML), documents (PDF, DOCX, PPTX),
 * images (PNG, JPEG, WebP, GIF), and audio (MP3, MP4, M4A, WAV, WebM, OGG, FLAC).
 * Images and audio are stored as-is (no conversion).
 */
export const EXTENSION_TO_MIME = new Map([
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".yml", "text/yaml"],
  [".yaml", "text/yaml"],
  [".pdf", "application/pdf"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
  [".mp3", "audio/mpeg"],
  [".mp4", "audio/mp4"],
  [".m4a", "audio/x-m4a"],
  [".wav", "audio/wav"],
  [".webm", "audio/webm"],
  [".ogg", "audio/ogg"],
  [".flac", "audio/flac"],
  [".mpeg", "audio/mpeg"],
  [".mpga", "audio/mpeg"],
]);

/**
 * All accepted MIME types for upload validation.
 *
 * Includes MIME type variants (e.g., `text/x-markdown`) because browsers and
 * operating systems report different MIME types for the same file format.
 * Server-side validation uses magic byte detection as the primary check;
 * this set is for fallback when magic bytes aren't conclusive.
 *
 * @see EXTENSION_TO_MIME for the list of supported file types
 */
export const ALLOWED_MIME_TYPES = new Set([
  "text/plain",
  "text/csv",
  "application/json",
  "text/markdown",
  "text/x-markdown",
  "text/yaml",
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

// ─────────────────────────────────────────────────────────────────────────────
// Chunked upload constants
// ─────────────────────────────────────────────────────────────────────────────

/** Files above this threshold use chunked upload (50MB) */
export const CHUNKED_UPLOAD_THRESHOLD = 50 * 1024 * 1024;

/** Size of each chunk for chunked uploads (5MB) */
export const CHUNK_SIZE = 5 * 1024 * 1024;

/** How long a chunked upload session stays alive before cleanup (2 hours) */
export const CHUNKED_UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;

export function isInvalidChatId(chatId: string): boolean {
  return (
    chatId.includes("..") ||
    chatId.startsWith("/") ||
    chatId.includes("\\") ||
    chatId.includes("\0")
  );
}

export const FILE_TYPE_NOT_ALLOWED_ERROR =
  "File type not allowed. Supported: CSV, JSON, TXT, MD, YML, PDF, DOCX, PPTX, PNG, JPG, JPEG, WebP, GIF, MP3, MP4, M4A, WAV, WebM, OGG, FLAC";

const SUPPORTED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export function isImageMimeType(mimeType: string): boolean {
  return SUPPORTED_IMAGE_MIMES.has(mimeType);
}

const SUPPORTED_AUDIO_MIMES = new Set([
  "audio/mpeg",
  "audio/mp4",
  "video/mp4",
  "audio/x-m4a",
  "audio/wav",
  "audio/wave",
  "audio/webm",
  "video/webm",
  "audio/ogg",
  "audio/flac",
  "audio/x-flac",
]);

export function isAudioMimeType(mimeType: string): boolean {
  return SUPPORTED_AUDIO_MIMES.has(mimeType);
}

/**
 * Mime types whose contents the agent can read directly as text. Anything
 * else is opaque bytes — the GET artifact route omits `contents` for these
 * to avoid round-tripping decoded-as-UTF-8 garbage through the LLM. Use
 * `parse_artifact` for PDF/DOCX/PPTX content extraction or
 * `display_artifact` for visual rendering.
 */
const TEXT_MIME_PREFIXES = ["text/"];
const TEXT_MIME_EXACT = new Set([
  "application/json",
  "application/yaml",
  "application/x-yaml",
  "application/xml",
  "application/javascript",
  "application/typescript",
  "application/sql",
  "application/x-sh",
  "application/x-python",
]);

export function isTextMimeType(mimeType: string): boolean {
  if (TEXT_MIME_EXACT.has(mimeType)) return true;
  return TEXT_MIME_PREFIXES.some((p) => mimeType.startsWith(p));
}

/**
 * Mime types we have a stream-based markdown converter for. The
 * `parse_artifact` endpoint runs these through the matching converter
 * and returns the markdown.
 */
const PARSEABLE_MIMES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);

export function isParseableMimeType(mimeType: string): boolean {
  return PARSEABLE_MIMES.has(mimeType);
}

/**
 * Common mime → file-extension lookup for download-filename derivation.
 * The fallback (`mimeType.split("/")[1]`) gives reasonable strings for
 * simple types (`application/pdf` → "pdf") but produces ugly results
 * for compound types (Office formats, image/svg+xml). Map the messy
 * cases explicitly; let everything else fall through to the suffix.
 */
const MIME_TO_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/json": "json",
  "application/yaml": "yaml",
  "application/x-yaml": "yaml",
  "application/xml": "xml",
  "application/zip": "zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/octet-stream": "bin",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/flac": "flac",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "text/plain": "txt",
  "text/html": "html",
  "text/css": "css",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/yaml": "yaml",
};

/** Best-guess file extension for a mime type. Falls back to `bin` for unknowns. */
export function extFromMime(mimeType: string): string {
  const direct = MIME_TO_EXT[mimeType];
  if (direct) return direct;
  // Fall back to the part after `/`, stripped of parameters (`; charset=…`)
  // and `+suffix` qualifiers (`image/svg+xml` → `svg`).
  const tail = mimeType.split("/")[1]?.split(";")[0]?.split("+")[0]?.trim();
  return tail && /^[a-z0-9]+$/i.test(tail) ? tail : "bin";
}

/**
 * Reconcile a stored `originalName` with the artifact's actual `mimeType`,
 * returning a filename whose extension matches the bytes. When the
 * scrubber lifts an embedded base64 blob without knowing the format yet,
 * it stamps the artifact with `<tool>-<ts>.bin`; the storage adapter
 * later sniffs the real mime, but `originalName` keeps its `.bin`. This
 * helper rewrites the extension at download time so the user gets
 * `foo.pdf` instead of `foo.bin` even for legacy artifacts.
 *
 * Logic:
 * 1. Compute the correct extension from the mime.
 * 2. If `originalName` already ends in that extension, keep it.
 * 3. If `originalName` ends in a different extension, swap it.
 * 4. If `originalName` has no extension, append.
 * 5. If no `originalName`, use `<title>.<ext>`.
 */
export function deriveDownloadFilename(opts: {
  mimeType: string;
  originalName?: string;
  title: string;
}): string {
  const ext = extFromMime(opts.mimeType);
  const fromOriginal = opts.originalName?.trim();
  if (fromOriginal) {
    const dot = fromOriginal.lastIndexOf(".");
    if (dot > 0 && dot < fromOriginal.length - 1) {
      const currentExt = fromOriginal.slice(dot + 1).toLowerCase();
      if (currentExt === ext.toLowerCase()) return fromOriginal;
      return `${fromOriginal.slice(0, dot)}.${ext}`;
    }
    return `${fromOriginal}.${ext}`;
  }
  return `${opts.title}.${ext}`;
}

export function getValidatedMimeType(fileName: string): string | undefined {
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx < 0) return undefined;
  const ext = fileName.slice(dotIdx).toLowerCase();
  return EXTENSION_TO_MIME.get(ext);
}

export const ALLOWED_EXTENSIONS = new Set(EXTENSION_TO_MIME.keys());
export const ALLOWED_EXTENSION_LIST = [...ALLOWED_EXTENSIONS];

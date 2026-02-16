/**
 * File upload constants and validation utilities.
 * Single source of truth for MIME types, extensions, and size limits.
 * Used by both server (validation) and client (UX feedback).
 */

/** Maximum file size for uploads (500MB) */
export const MAX_FILE_SIZE = 500 * 1024 * 1024;

/** Maximum file size for PDF uploads (50MB) - lower than other types due to memory usage during extraction */
export const MAX_PDF_SIZE = 50 * 1024 * 1024;

/** Maximum file size for Office document uploads (50MB) - same limit as PDF for same reasons */
export const MAX_OFFICE_SIZE = 50 * 1024 * 1024;

/** Maximum file size for image uploads (5MB) - matches Anthropic API per-image limit */
export const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

/** Maximum cumulative decompressed content size for OOXML files (200MB) */
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
 * and images (PNG, JPEG, WebP, GIF). Images are stored as-is (no conversion)
 * and sent as native image content parts to LLMs.
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

/** Returns true if chatId contains path traversal or unsafe characters */
export function isInvalidChatId(chatId: string): boolean {
  return (
    chatId.includes("..") ||
    chatId.startsWith("/") ||
    chatId.includes("\\") ||
    chatId.includes("\0")
  );
}

/** Error message for disallowed file types */
export const FILE_TYPE_NOT_ALLOWED_ERROR =
  "File type not allowed. Supported: CSV, JSON, TXT, MD, YML, PDF, DOCX, PPTX, PNG, JPG, JPEG, WebP, GIF";

/** MIME types supported for image upload and LLM vision input */
const SUPPORTED_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Returns true if the given MIME type is a supported image type */
export function isImageMimeType(mimeType: string): boolean {
  return SUPPORTED_IMAGE_MIMES.has(mimeType);
}

/** Extract and validate file extension against EXTENSION_TO_MIME. Returns MIME type or undefined. */
export function getValidatedMimeType(fileName: string): string | undefined {
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx < 0) return undefined;
  const ext = fileName.slice(dotIdx).toLowerCase();
  return EXTENSION_TO_MIME.get(ext);
}

/** Allowed file extensions for client-side validation */
export const ALLOWED_EXTENSIONS = new Set(EXTENSION_TO_MIME.keys());

/** List of allowed extensions for display purposes */
export const ALLOWED_EXTENSION_LIST = [...ALLOWED_EXTENSIONS];

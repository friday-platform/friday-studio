/**
 * File upload constants and validation utilities.
 * Single source of truth for MIME types, extensions, and size limits.
 * Used by both server (validation) and client (UX feedback).
 */

/** Maximum file size for uploads (500MB) */
export const MAX_FILE_SIZE = 500 * 1024 * 1024;

/**
 * Extension to MIME type mapping for allowed file types.
 *
 * **Why text-only files?**
 *
 * 1. **Security** - Text files are inherently safe to read and display without
 *    special handling. Binary files (executables, archives, images) carry security
 *    risks and require sandboxed rendering.
 *
 * 2. **Agent capability** - The `artifacts_get` tool returns file contents inline
 *    as text. Binary files would require base64 encoding or streaming, adding
 *    complexity without clear use cases today.
 *
 * 3. **MVP scope** - These four formats cover the primary agent use cases:
 *    - CSV: Data analysis, spreadsheets, exports
 *    - JSON: API responses, configs, structured data
 *    - TXT: Logs, notes, plain text content
 *    - MD: Documentation, formatted content
 *
 * 4. **Storage efficiency** - Text files compress well. Binary uploads would
 *    require different storage strategies (deduplication, CDN, etc).
 *
 * Future expansion should be driven by concrete use cases, not speculation.
 */
export const EXTENSION_TO_MIME = new Map([
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".txt", "text/plain"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".yml", "text/yaml"],
  [".yaml", "text/yaml"],
]);

/**
 * All accepted MIME types for upload validation.
 *
 * Includes MIME type variants (e.g., `text/x-markdown`) because browsers and
 * operating systems report different MIME types for the same file format.
 * Server-side validation uses magic byte detection as the primary check;
 * this set is for fallback when magic bytes aren't conclusive.
 *
 * @see EXTENSION_TO_MIME for the rationale behind text-only file types
 */
export const ALLOWED_MIME_TYPES = new Set([
  "text/plain",
  "text/csv",
  "application/json",
  "text/markdown",
  "text/x-markdown",
  "text/yaml",
]);

/** Allowed file extensions for client-side validation */
export const ALLOWED_EXTENSIONS = new Set(EXTENSION_TO_MIME.keys());

/** List of allowed extensions for display purposes */
export const ALLOWED_EXTENSION_LIST = [...ALLOWED_EXTENSIONS];

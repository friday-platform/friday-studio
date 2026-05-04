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
 * Extension → mime + upload-allowlist flag.
 *
 * Single source of truth for both extension-driven mime inference and
 * the UI upload allowlist. `uploadable: true` entries gate
 * `getValidatedMimeType` and `ALLOWED_EXTENSIONS`; `uploadable: false`
 * entries are agent-side inferences only — markup/source/config text
 * formats that agents commonly write to scratch and register as
 * artifacts. Adding such an extension here does NOT widen the UI
 * upload allowlist.
 */
export const EXTENSION_TO_MIME = new Map<string, { mime: string; uploadable: boolean }>([
  // Uploadable: text/data
  [".csv", { mime: "text/csv", uploadable: true }],
  [".json", { mime: "application/json", uploadable: true }],
  [".txt", { mime: "text/plain", uploadable: true }],
  [".md", { mime: "text/markdown", uploadable: true }],
  [".markdown", { mime: "text/markdown", uploadable: true }],
  [".yml", { mime: "text/yaml", uploadable: true }],
  [".yaml", { mime: "text/yaml", uploadable: true }],
  // Uploadable: documents
  [".pdf", { mime: "application/pdf", uploadable: true }],
  [
    ".docx",
    {
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      uploadable: true,
    },
  ],
  [
    ".pptx",
    {
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      uploadable: true,
    },
  ],
  // Uploadable: images
  [".png", { mime: "image/png", uploadable: true }],
  [".jpg", { mime: "image/jpeg", uploadable: true }],
  [".jpeg", { mime: "image/jpeg", uploadable: true }],
  [".webp", { mime: "image/webp", uploadable: true }],
  [".gif", { mime: "image/gif", uploadable: true }],
  // Uploadable: audio
  [".mp3", { mime: "audio/mpeg", uploadable: true }],
  [".mp4", { mime: "audio/mp4", uploadable: true }],
  [".m4a", { mime: "audio/x-m4a", uploadable: true }],
  [".wav", { mime: "audio/wav", uploadable: true }],
  [".webm", { mime: "audio/webm", uploadable: true }],
  [".ogg", { mime: "audio/ogg", uploadable: true }],
  [".flac", { mime: "audio/flac", uploadable: true }],
  [".mpeg", { mime: "audio/mpeg", uploadable: true }],
  [".mpga", { mime: "audio/mpeg", uploadable: true }],
  // Agent-inference only: markup
  [".html", { mime: "text/html", uploadable: false }],
  [".htm", { mime: "text/html", uploadable: false }],
  [".xml", { mime: "application/xml", uploadable: false }],
  [".svg", { mime: "image/svg+xml", uploadable: false }],
  [".css", { mime: "text/css", uploadable: false }],
  // Agent-inference only: source code
  [".ts", { mime: "text/x-typescript", uploadable: false }],
  [".tsx", { mime: "text/x-typescript", uploadable: false }],
  [".js", { mime: "text/javascript", uploadable: false }],
  [".jsx", { mime: "text/javascript", uploadable: false }],
  [".mjs", { mime: "text/javascript", uploadable: false }],
  [".cjs", { mime: "text/javascript", uploadable: false }],
  [".py", { mime: "text/x-python", uploadable: false }],
  [".go", { mime: "text/x-go", uploadable: false }],
  [".rs", { mime: "text/x-rust", uploadable: false }],
  [".sh", { mime: "text/x-shellscript", uploadable: false }],
  [".bash", { mime: "text/x-shellscript", uploadable: false }],
  [".sql", { mime: "text/x-sql", uploadable: false }],
  // Agent-inference only: config/log
  [".toml", { mime: "text/x-toml", uploadable: false }],
  [".ini", { mime: "text/plain", uploadable: false }],
  [".conf", { mime: "text/plain", uploadable: false }],
  [".log", { mime: "text/plain", uploadable: false }],
  [".tsv", { mime: "text/tab-separated-values", uploadable: false }],
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
  // SVG is XML text. Treating it as text means agents stamp the mime
  // explicitly at artifact-create time, which keeps the daemon's CSP
  // sandbox firing on the /content route. Without this, .svg falls
  // through to the binary-byte sniff and stores as octet-stream — at
  // which point the sandbox key (`mimeType === "image/svg+xml"`) misses
  // and an SVG `<script>` would execute same-origin.
  "image/svg+xml",
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
  // Hyphenated source/config mimes the agent-side inference can stamp.
  // The fallback `tail` regex (`^[a-z0-9]+$`) rejects hyphens and falls
  // through to `bin`, so without these the scrubber `.bin` repair
  // produces e.g. `tool-12345.bin` instead of `tool-12345.ts`.
  "text/x-typescript": "ts",
  "text/x-python": "py",
  "text/x-go": "go",
  "text/x-rust": "rs",
  "text/x-shellscript": "sh",
  "text/x-sql": "sql",
  "text/x-toml": "toml",
  "text/tab-separated-values": "tsv",
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
 * Pick a download filename for an artifact.
 *
 * `originalName` is the source of truth when it carries a usable
 * extension that agrees with the stored mime. The scrubber path still
 * gets repaired: when the scrubber lifts an embedded base64 blob without
 * knowing the format, it stamps `<tool>-<ts>.bin`; later the real mime
 * is known and we rewrite the `.bin` to the right extension.
 *
 * Unknown/octet-stream artifacts keep their original extension because
 * the stored mime carries no better information.
 */
export function deriveDownloadFilename(opts: {
  mimeType: string;
  originalName?: string;
  title: string;
}): string {
  // Strip mime parameters (`; charset=…`) up front so the equality
  // check against the filename-inferred mime survives storage adapters
  // that round-trip text mimes with a charset attached. Without this,
  // `notes.md` + stored `text/markdown; charset=utf-8` silently rewrote
  // to `notes.markdown`.
  const baseMime = opts.mimeType.split(";")[0]?.trim() || opts.mimeType;
  const fromOriginal = opts.originalName?.trim();
  if (fromOriginal) {
    const dot = fromOriginal.lastIndexOf(".");
    const hasExt = dot > 0 && dot < fromOriginal.length - 1;
    if (hasExt) {
      const currentExt = fromOriginal.slice(dot + 1).toLowerCase();
      // Scrubber path: `.bin` placeholder → swap to real ext.
      if (currentExt === "bin") {
        return `${fromOriginal.slice(0, dot)}.${extFromMime(baseMime)}`;
      }

      const originalMime = inferMimeFromFilename(fromOriginal);
      if (baseMime === "application/octet-stream" || originalMime === baseMime) {
        return fromOriginal;
      }
      return `${fromOriginal.slice(0, dot)}.${extFromMime(baseMime)}`;
    }
    return `${fromOriginal}.${extFromMime(baseMime)}`;
  }
  return `${opts.title}.${extFromMime(baseMime)}`;
}

function lookupExtension(fileName: string): { mime: string; uploadable: boolean } | undefined {
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx < 0) return undefined;
  return EXTENSION_TO_MIME.get(fileName.slice(dotIdx).toLowerCase());
}

/**
 * Mime for a UI-uploadable extension, or `undefined` for any extension
 * that is unknown or restricted to agent-side inference. Gates the
 * upload allowlist.
 */
export function getValidatedMimeType(fileName: string): string | undefined {
  const entry = lookupExtension(fileName);
  return entry?.uploadable ? entry.mime : undefined;
}

/**
 * Mime for any known extension, including agent-only ones. Used at
 * `artifacts_create` time so text/markup/source-code files persist
 * with a meaningful mime instead of falling through to the storage
 * layer's binary-only magic-byte sniff and ending up as
 * `application/octet-stream`. Returns `undefined` for unknown
 * extensions — caller should let the storage layer decide.
 */
export function inferMimeFromFilename(fileName: string): string | undefined {
  return lookupExtension(fileName)?.mime;
}

export const ALLOWED_EXTENSIONS = new Set(
  [...EXTENSION_TO_MIME].filter(([, v]) => v.uploadable).map(([k]) => k),
);
export const ALLOWED_EXTENSION_LIST = [...ALLOWED_EXTENSIONS];

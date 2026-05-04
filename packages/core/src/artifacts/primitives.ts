import { z } from "zod";

/**
 * File artifact data (output, post-redesign 2026-05-02).
 *
 * Was `{ path, mimeType, originalName? }` with `path` being an
 * absolute filesystem path — broken if the install moves, leaks the
 * storage layer into the public API, two-store-consistency hazard
 * with the metadata KV.
 *
 * New shape: blob lives in JetStream Object Store, named by SHA-256.
 * Metadata carries the content reference + sniffed mime + size. Same
 * blob saved twice = one Object Store entry, two metadata refs
 * (deduplication is automatic).
 */
export const FileDataSchema = z.object({
  /** SHA-256 hex of the blob bytes — the Object Store entry's name. */
  contentRef: z
    .string()
    .regex(/^[0-9a-f]{64}$/, "contentRef must be a lowercase hex sha256")
    .describe("SHA-256 (hex) of the blob — the Object Store entry's name"),
  /** Size in bytes. */
  size: z.number().int().nonnegative().describe("Blob size in bytes"),
  mimeType: z.string().describe("MIME type sniffed from magic bytes at write time, then frozen"),
  originalName: z.string().optional().describe("Original filename from upload, when available"),
});
export type FileData = z.infer<typeof FileDataSchema>;

/**
 * File artifact data (input). Caller passes content directly — bytes
 * or a UTF-8 string. The storage layer hashes, sniffs the mime,
 * sizes it, writes to Object Store, and produces the FileData above.
 *
 * Legacy `{ path: <abs-path> }` shape is gone. Callers that previously
 * wrote a file and passed the path now pass the bytes directly. The
 * route's multipart-upload handler reads the upload body straight to
 * bytes.
 */
export const FileDataInputSchema = z.object({
  /**
   * Blob content. String → encoded as UTF-8. Uint8Array → used as-is.
   * Over the wire (JSON), pass content as a base64 string and set
   * `contentEncoding: "base64"`.
   */
  content: z.union([z.string(), z.instanceof(Uint8Array)]).describe("Raw blob content"),
  /** Set to "base64" if `content` is a base64-encoded string. */
  contentEncoding: z
    .enum(["utf-8", "base64"])
    .optional()
    .describe("Encoding hint for string content"),
  mimeType: z.string().optional().describe("Override mime sniffer (rarely needed)"),
  originalName: z.string().optional().describe("Original filename, optional"),
});
export type FileDataInput = z.infer<typeof FileDataInputSchema>;

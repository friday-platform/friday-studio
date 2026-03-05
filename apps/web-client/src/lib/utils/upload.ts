/**
 * Shared file upload utility.
 *
 * Handles client-side validation, simple vs chunked upload routing,
 * progress tracking, and abort support. Used by both the chat file drop
 * flow and workspace resource uploads.
 *
 * @module
 */

import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  CHUNK_SIZE,
  CHUNKED_UPLOAD_THRESHOLD,
  EXTENSION_TO_MIME,
  isImageMimeType,
  MAX_FILE_SIZE,
  MAX_IMAGE_SIZE,
  MAX_OFFICE_SIZE,
  MAX_PDF_SIZE,
} from "@atlas/core/artifacts/file-upload";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { z } from "zod";

/** Upload lifecycle status. */
export type UploadStatus = "uploading" | "converting" | "ready" | "error";

// ─────────────────────────────────────────────────────────────────────────────
// Zod Schemas
// ─────────────────────────────────────────────────────────────────────────────

const SimpleUploadResponseSchema = z.object({ artifact: z.object({ id: z.string() }) });
const ErrorResponseSchema = z.object({ error: z.string() });
const InitResponseSchema = z.object({ uploadId: z.string(), totalChunks: z.number() });
const StatusResponseSchema = z.object({ completedChunks: z.array(z.number()) });
const CompleteAcceptedSchema = z.object({ status: z.literal("completing") });
const StatusPollResponseSchema = z.object({
  status: z.enum(["uploading", "completing", "completed", "failed"]),
  result: z
    .union([z.object({ artifact: z.object({ id: z.string() }) }), z.object({ error: z.string() })])
    .optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// File Validation (client-side UX - server still validates)
// Uses shared constants from @atlas/core/artifacts/file-upload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates a file for upload eligibility.
 * Checks size first, then MIME type, then extension fallback.
 * This is UX enhancement only - server must still validate.
 *
 * @param file - The File object to validate
 * @returns Discriminated union: { valid: true } or { valid: false, error: string }
 */
export function validateFile(file: File): { valid: true } | { valid: false; error: string } {
  // Empty file check (quick, definitive)
  if (file.size === 0) {
    return { valid: false, error: "File is empty." };
  }

  // Size check first (quick, definitive)
  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: "File too large. Maximum size is 500MB." };
  }

  // Binary-to-markdown formats have a lower size limit due to memory usage during extraction
  const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
  if (ext === ".pdf" && file.size > MAX_PDF_SIZE) {
    const maxMB = Math.round(MAX_PDF_SIZE / (1024 * 1024));
    return { valid: false, error: `PDF files must be under ${maxMB}MB.` };
  }
  if ((ext === ".docx" || ext === ".pptx") && file.size > MAX_OFFICE_SIZE) {
    const maxMB = Math.round(MAX_OFFICE_SIZE / (1024 * 1024));
    return { valid: false, error: `${ext.slice(1).toUpperCase()} files must be under ${maxMB}MB.` };
  }

  const mimeForExt = EXTENSION_TO_MIME.get(ext);
  if (mimeForExt && isImageMimeType(mimeForExt) && file.size > MAX_IMAGE_SIZE) {
    return { valid: false, error: "Image files must be under 5MB." };
  }

  // MIME type check (browser-provided, may be empty)
  if (file.type && ALLOWED_MIME_TYPES.has(file.type)) {
    return { valid: true };
  }

  // Extension fallback (handles empty/generic MIME types)
  if (ALLOWED_EXTENSIONS.has(ext)) {
    return { valid: true };
  }

  return {
    valid: false,
    error:
      "Unsupported file type. Only CSV, JSON, TXT, MD, YML, PDF, DOCX, PPTX, PNG, JPG, WebP, and GIF files are allowed.",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Upload options
// ─────────────────────────────────────────────────────────────────────────────

interface UploadOptions {
  chatId?: string;
  workspaceId?: string;
  artifactId?: string;
  onProgress?: (loaded: number) => void;
  onStatusChange?: (status: UploadStatus) => void;
  abortSignal?: AbortSignal;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts an error message from an unknown response body using ErrorResponseSchema.
 *
 * @param data - Unknown response body to parse
 * @param fallback - Fallback message if parsing fails
 * @returns The extracted error string or the fallback
 */
function extractError(data: unknown, fallback: string): string {
  const parsed = ErrorResponseSchema.safeParse(data);
  return parsed.success ? parsed.data.error : fallback;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Uploads a file to the server with client-side validation.
 * Automatically picks single-request or chunked upload based on file size.
 * Passes optional fields (workspaceId, artifactId) through
 * to the server for artifact creation or replacement.
 *
 * @param file - The File to upload
 * @param opts - Upload options (chatId, workspaceId, artifactId, callbacks)
 * @returns Discriminated union: { artifactId: string } on success, { error: string } on failure
 */
async function uploadArtifact(
  file: File,
  opts?: UploadOptions,
): Promise<{ artifactId: string } | { error: string }> {
  const validation = validateFile(file);
  if (!validation.valid) {
    return { error: validation.error };
  }

  if (file.size >= CHUNKED_UPLOAD_THRESHOLD) {
    return await uploadFileChunked(file, opts);
  }
  return await uploadFileSimple(file, opts);
}

/**
 * Uploads a file to the server. Automatically picks single-request or chunked
 * upload based on file size.
 *
 * @deprecated Use uploadArtifact instead
 */
export function uploadFile(
  file: File,
  chatId?: string,
  onProgress?: (loaded: number) => void,
  abortSignal?: AbortSignal,
  onStatusChange?: (status: UploadStatus) => void,
): Promise<{ artifactId: string } | { error: string }> {
  return uploadArtifact(file, { chatId, onProgress, abortSignal, onStatusChange });
}

// ─────────────────────────────────────────────────────────────────────────────
// Simple upload (XHR for progress tracking)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Single-request upload via XHR (for files below CHUNKED_UPLOAD_THRESHOLD).
 */
function uploadFileSimple(
  file: File,
  opts?: UploadOptions,
): Promise<{ artifactId: string } | { error: string }> {
  const formData = new FormData();
  formData.set("file", file);
  if (opts?.chatId) formData.set("chatId", opts.chatId);
  if (opts?.workspaceId) formData.set("workspaceId", opts.workspaceId);
  if (opts?.artifactId) formData.set("artifactId", opts.artifactId);

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && opts?.onProgress) {
        opts.onProgress(event.loaded);
      }
    };

    xhr.onload = () => {
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText) as unknown;
      } catch {
        resolve({
          error:
            xhr.status >= 200 && xhr.status < 300
              ? "Invalid response from server"
              : `Upload failed (${xhr.status})`,
        });
        return;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = SimpleUploadResponseSchema.safeParse(body);
        if (parsed.success) {
          resolve({ artifactId: parsed.data.artifact.id });
        } else {
          resolve({ error: "Invalid response from server" });
        }
      } else {
        resolve({ error: extractError(body, `Upload failed (${xhr.status})`) });
      }
    };

    xhr.onerror = () => {
      resolve({ error: "Network error" });
    };

    xhr.onabort = () => {
      resolve({ error: "Upload cancelled" });
    };

    if (opts?.abortSignal) {
      opts.abortSignal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.open("POST", `${getAtlasDaemonUrl()}/api/artifacts/upload`);
    xhr.send(formData);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Chunked upload
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chunked upload with per-chunk retry and resume support.
 * Splits file into CHUNK_SIZE pieces, uploads sequentially,
 * and retries each chunk up to 3 times with exponential backoff.
 */
async function uploadFileChunked(
  file: File,
  opts?: UploadOptions,
): Promise<{ artifactId: string } | { error: string }> {
  const baseUrl = getAtlasDaemonUrl();
  const abortSignal = opts?.abortSignal;

  // 1. Init session
  let initRes: Response;
  try {
    initRes = await fetch(`${baseUrl}/api/chunked-upload/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: file.name,
        fileSize: file.size,
        chatId: opts?.chatId,
        workspaceId: opts?.workspaceId,
        artifactId: opts?.artifactId,
      }),
      signal: abortSignal,
    });
  } catch {
    return { error: "Network error during upload init" };
  }

  const initBody: unknown = await initRes.json().catch(() => ({}));
  if (!initRes.ok) {
    return { error: extractError(initBody, `Init failed (${initRes.status})`) };
  }

  const initParsed = InitResponseSchema.safeParse(initBody);
  if (!initParsed.success) {
    return { error: "Invalid response from server" };
  }
  const { uploadId, totalChunks } = initParsed.data;

  // 2. Upload chunks sequentially with retry
  const MAX_RETRIES = 3;
  const MAX_RESUME_ATTEMPTS = 1;
  let completedSet = new Set<number>();
  let resumeAttempts = 0;

  for (let i = 0; i < totalChunks; i++) {
    if (abortSignal?.aborted) return { error: "Upload cancelled" };
    if (completedSet.has(i)) continue;

    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunk = file.slice(start, end);

    let uploaded = false;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (abortSignal?.aborted) return { error: "Upload cancelled" };

      try {
        const res = await fetch(`${baseUrl}/api/chunked-upload/${uploadId}/chunk/${i}`, {
          method: "PUT",
          body: chunk,
          signal: abortSignal,
        });

        if (res.ok) {
          uploaded = true;
          completedSet.add(i);
          opts?.onProgress?.(Math.min((i + 1) * CHUNK_SIZE, file.size));
          break;
        }

        // Non-retryable client errors
        if (res.status >= 400 && res.status < 500) {
          const data: unknown = await res.json().catch(() => ({}));
          return { error: extractError(data, `Chunk upload failed (${res.status})`) };
        }
      } catch {
        // Network error — retry after backoff
      }

      if (attempt < MAX_RETRIES - 1) {
        const delay = Math.round(1000 * 2 ** attempt * (0.5 + Math.random() * 0.5));
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          abortSignal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        if (abortSignal?.aborted) return { error: "Upload cancelled" };
      }
    }

    if (!uploaded) {
      // All retries exhausted — try to resume from server state (once)
      if (resumeAttempts < MAX_RESUME_ATTEMPTS) {
        resumeAttempts++;
        try {
          const statusRes = await fetch(`${baseUrl}/api/chunked-upload/${uploadId}/status`);
          if (statusRes.ok) {
            const statusParsed = StatusResponseSchema.safeParse(await statusRes.json());
            if (statusParsed.success) {
              completedSet = new Set(statusParsed.data.completedChunks);
              i--;
              continue;
            }
          }
        } catch {
          // Status check also failed
        }
      }
      return { error: `Failed to upload chunk ${i} after ${MAX_RETRIES} attempts` };
    }
  }

  // 3. Complete — server returns 202, then we poll for result
  try {
    const completeRes = await fetch(`${baseUrl}/api/chunked-upload/${uploadId}/complete`, {
      method: "POST",
      signal: abortSignal,
    });

    if (!completeRes.ok) {
      const data: unknown = await completeRes.json().catch(() => ({}));
      return { error: extractError(data, `Complete failed (${completeRes.status})`) };
    }

    const completeBody: unknown = await completeRes.json().catch(() => ({}));

    const asyncParsed = CompleteAcceptedSchema.safeParse(completeBody);
    if (!asyncParsed.success) {
      return { error: "Invalid response from server" };
    }

    // Signal "converting" state
    opts?.onProgress?.(file.size);
    opts?.onStatusChange?.("converting");

    const POLL_INTERVAL_MS = 2000;
    const MAX_POLL_ATTEMPTS = 300; // 10 minutes max

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      if (abortSignal?.aborted) return { error: "Upload cancelled" };

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, POLL_INTERVAL_MS);
        abortSignal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      if (abortSignal?.aborted) return { error: "Upload cancelled" };

      try {
        const statusRes = await fetch(`${baseUrl}/api/chunked-upload/${uploadId}/status`, {
          signal: abortSignal,
        });
        if (statusRes.status === 404) {
          return { error: "Upload session expired" };
        }
        if (!statusRes.ok) continue;

        const statusParsed = StatusPollResponseSchema.safeParse(await statusRes.json());
        if (!statusParsed.success) continue;

        const { status, result } = statusParsed.data;

        if (status === "completed" && result && "artifact" in result) {
          return { artifactId: result.artifact.id };
        }

        if (status === "failed") {
          const errorMsg = result && "error" in result ? result.error : "Conversion failed";
          return { error: errorMsg };
        }

        // Still completing — keep polling
      } catch {
        // Network error on poll — retry
      }
    }

    return { error: "Conversion timed out" };
  } catch {
    return { error: "Network error during upload completion" };
  }
}

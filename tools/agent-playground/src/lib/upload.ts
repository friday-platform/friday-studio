/**
 * File upload utility for the playground. Talks directly to the daemon's
 * /api/artifacts/upload endpoint.
 */

import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  EXTENSION_TO_MIME,
  isAudioMimeType,
  isImageMimeType,
  MAX_AUDIO_SIZE,
  MAX_FILE_SIZE,
  MAX_IMAGE_SIZE,
  MAX_OFFICE_SIZE,
  MAX_PDF_SIZE,
} from "@atlas/core/artifacts/file-upload";
import { z } from "zod";

export type UploadStatus = "uploading" | "converting" | "ready" | "error";

const SimpleUploadResponseSchema = z.object({ artifact: z.object({ id: z.string() }) });
const ErrorResponseSchema = z.object({ error: z.string() });

function extractError(data: unknown, fallback: string): string {
  const parsed = ErrorResponseSchema.safeParse(data);
  return parsed.success ? parsed.data.error : fallback;
}

/** Client-side UX validation — server still validates. */
export function validateFile(file: File): { valid: true } | { valid: false; error: string } {
  if (file.size === 0) {
    return { valid: false, error: "File is empty." };
  }

  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: "File too large. Maximum size is 500MB." };
  }

  const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
  if (ext === ".pdf" && file.size > MAX_PDF_SIZE) {
    const maxMB = Math.round(MAX_PDF_SIZE / (1024 * 1024));
    return { valid: false, error: `PDF files must be under ${maxMB}MB.` };
  }
  if ((ext === ".docx" || ext === ".pptx") && file.size > MAX_OFFICE_SIZE) {
    const maxMB = Math.round(MAX_OFFICE_SIZE / (1024 * 1024));
    return { valid: false, error: `${ext.slice(1).toUpperCase()} files must be under ${maxMB}MB.` };
  }

  const mimeForExt = EXTENSION_TO_MIME.get(ext)?.mime;
  if (mimeForExt && isImageMimeType(mimeForExt) && file.size > MAX_IMAGE_SIZE) {
    return { valid: false, error: "Image files must be under 5MB." };
  }
  if (mimeForExt && isAudioMimeType(mimeForExt) && file.size > MAX_AUDIO_SIZE) {
    const maxMB = Math.round(MAX_AUDIO_SIZE / (1024 * 1024));
    return { valid: false, error: `Audio files must be under ${maxMB}MB.` };
  }

  if (file.type && ALLOWED_MIME_TYPES.has(file.type)) {
    return { valid: true };
  }

  if (ALLOWED_EXTENSIONS.has(ext)) {
    return { valid: true };
  }

  return {
    valid: false,
    error:
      "Unsupported file type. Only CSV, JSON, TXT, MD, YML, PDF, DOCX, PPTX, PNG, JPG, WebP, GIF, and audio files (MP3, MP4, M4A, WAV, WebM, OGG, FLAC) are allowed.",
  };
}

/**
 * Upload a file to the daemon's artifact endpoint.
 * Simple XHR upload with progress tracking — no chunked upload needed
 * for the playground's typical file sizes.
 */
export function uploadFile(
  file: File,
  onProgress?: (loaded: number) => void,
  abortSignal?: AbortSignal,
  onStatusChange?: (status: UploadStatus) => void,
): Promise<{ artifactId: string } | { error: string }> {
  const validation = validateFile(file);
  if (!validation.valid) {
    return Promise.resolve({ error: validation.error });
  }

  const formData = new FormData();
  formData.set("file", file);
  formData.set("workspaceId", "playground");

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        onProgress(event.loaded);
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
          onStatusChange?.("ready");
          resolve({ artifactId: parsed.data.artifact.id });
        } else {
          resolve({ error: "Invalid response from server" });
        }
      } else {
        resolve({ error: extractError(body, `Upload failed (${xhr.status})`) });
      }
    };

    xhr.onerror = () => {
      resolve({ error: "Network error — is the daemon running?" });
    };

    xhr.onabort = () => {
      resolve({ error: "Upload cancelled" });
    };

    if (abortSignal) {
      abortSignal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.open("POST", "/api/daemon/api/artifacts/upload");
    xhr.send(formData);
  });
}

/**
 * File upload utility for the playground. Talks directly to the daemon's
 * /api/artifacts/upload endpoint.
 */

import {
  ACCEPTED_TYPES_DESCRIPTION,
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
    error: `Unsupported file type. Supported: ${ACCEPTED_TYPES_DESCRIPTION}.`,
  };
}

/**
 * Upload a file to the daemon's artifact endpoint.
 * Simple XHR upload with progress tracking — no chunked upload needed
 * for the playground's typical file sizes.
 *
 * `workspaceId` defaults to "playground" for the HITL elicitation flow that
 * always targets the playground workspace; chat-input attachments pass the
 * active workspace so the upload's `requireWorkspaceMember` check passes.
 */
export function uploadFile(
  file: File,
  onProgress?: (loaded: number) => void,
  abortSignal?: AbortSignal,
  onStatusChange?: (status: UploadStatus) => void,
  workspaceId: string = "playground",
): Promise<{ artifactId: string } | { error: string }> {
  const validation = validateFile(file);
  if (!validation.valid) {
    return Promise.resolve({ error: validation.error });
  }

  const formData = new FormData();
  formData.set("file", file);
  formData.set("workspaceId", workspaceId);

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

/**
 * Schema returned by `POST /api/scratch/upload` — the absolute path on the
 * daemon's filesystem (typically `{FRIDAY_HOME}/scratch/uploads/{chatId}/
 * {filename}`), plus the validated mime and stored byte count. The agent
 * reads from `path` via the `read_attachment` tool; the chat bubble shows
 * `filename` + `mediaType`.
 */
const ScratchUploadResponseSchema = z.object({
  path: z.string(),
  filename: z.string(),
  mediaType: z.string(),
  size: z.number(),
});

export type ScratchUploadResult = z.infer<typeof ScratchUploadResponseSchema>;

/**
 * Upload a file to the per-chat scratch dir on the daemon's filesystem.
 * Returns the absolute path the daemon wrote — the agent reads from there
 * via `read_attachment(path)`. No artifact storage, no library entry.
 *
 * `chatId` and `workspaceId` are required (the route rejects without them).
 * Use {@link uploadFile} instead for the HITL elicitation flow that wants
 * a first-class artifact in the library.
 */
export function uploadFileToScratch(
  file: File,
  opts: {
    chatId: string;
    workspaceId: string;
    onProgress?: (loaded: number) => void;
    abortSignal?: AbortSignal;
  },
): Promise<ScratchUploadResult | { error: string }> {
  const validation = validateFile(file);
  if (!validation.valid) {
    return Promise.resolve({ error: validation.error });
  }

  const formData = new FormData();
  formData.set("file", file);
  formData.set("chatId", opts.chatId);
  formData.set("workspaceId", opts.workspaceId);

  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && opts.onProgress) opts.onProgress(event.loaded);
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
        const parsed = ScratchUploadResponseSchema.safeParse(body);
        if (parsed.success) {
          resolve(parsed.data);
        } else {
          resolve({ error: "Invalid response from server" });
        }
      } else {
        resolve({ error: extractError(body, `Upload failed (${xhr.status})`) });
      }
    };

    xhr.onerror = () => resolve({ error: "Network error — is the daemon running?" });
    xhr.onabort = () => resolve({ error: "Upload cancelled" });

    if (opts.abortSignal) {
      opts.abortSignal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.open("POST", "/api/daemon/api/scratch/upload");
    xhr.send(formData);
  });
}

/**
 * Resource upload and replace utilities.
 *
 * Simple multipart/form-data uploads to the resource endpoints.
 * No chunked upload for v1 — just file + workspaceId.
 *
 * @module
 */

import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { z } from "zod";

const ErrorResponseSchema = z.object({ error: z.string() });

function extractError(data: unknown, fallback: string): string {
  const parsed = ErrorResponseSchema.safeParse(data);
  return parsed.success ? parsed.data.error : fallback;
}

/** Result type for resource upload/replace operations. */
export type ResourceMutationResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Uploads a file to create a new resource.
 *
 * @param file - The file to upload
 * @param workspaceId - Target workspace
 * @returns Success indicator or error with HTTP status code
 */
export async function uploadResource(
  file: File,
  workspaceId: string,
): Promise<ResourceMutationResult> {
  const formData = new FormData();
  formData.set("file", file);

  try {
    const res = await fetch(
      `${getAtlasDaemonUrl()}/api/workspaces/${encodeURIComponent(workspaceId)}/resources/upload`,
      { method: "POST", body: formData },
    );

    if (res.ok) {
      return { ok: true };
    }

    const body: unknown = await res.json().catch(() => ({}));
    return {
      ok: false,
      status: res.status,
      error: extractError(body, `Upload failed (${res.status})`),
    };
  } catch {
    return { ok: false, status: 0, error: "Network error" };
  }
}

/**
 * Replaces an existing resource's data with a new file.
 *
 * @param file - The replacement file
 * @param workspaceId - Target workspace
 * @param slug - Resource slug to replace
 * @returns Success indicator or error with HTTP status code
 */
export async function replaceResource(
  file: File,
  workspaceId: string,
  slug: string,
): Promise<ResourceMutationResult> {
  const formData = new FormData();
  formData.set("file", file);

  try {
    const res = await fetch(
      `${getAtlasDaemonUrl()}/api/workspaces/${encodeURIComponent(workspaceId)}/resources/${encodeURIComponent(slug)}`,
      { method: "PUT", body: formData },
    );

    if (res.ok) {
      return { ok: true };
    }

    const body: unknown = await res.json().catch(() => ({}));
    return {
      ok: false,
      status: res.status,
      error: extractError(body, `Replace failed (${res.status})`),
    };
  } catch {
    return { ok: false, status: 0, error: "Network error" };
  }
}

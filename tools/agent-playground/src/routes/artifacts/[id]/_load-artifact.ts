/**
 * Shared loader for the artifact subpath renderers (`./table`, `./markdown`,
 * future `./raw` / `./diff`). Each renderer wants the same shape: the
 * artifact's raw text + provenance display names ("From <chat> in
 * <workspace>") for the header row.
 *
 * Errors that should strand the user (missing artifact, daemon unreachable)
 * throw via `error()`. Provenance lookups are best-effort — a stale
 * workspace id or a deleted chat reduces to a missing name, never a page
 * failure.
 */

import { error } from "@sveltejs/kit";

export interface ArtifactLoadResult {
  artifactId: string;
  mimeType: string;
  filename: string;
  text: string;
  contentUrl: string;
  workspaceId: string | null;
  workspaceName: string | null;
  chatId: string | null;
  chatTitle: string | null;
}

export async function loadArtifactWithProvenance(
  artifactId: string,
  fetchFn: typeof fetch,
): Promise<ArtifactLoadResult> {
  const metaUrl = `/api/daemon/api/artifacts/${encodeURIComponent(artifactId)}`;
  const metaRes = await fetchFn(metaUrl);
  if (metaRes.status === 404) {
    throw error(404, "Artifact not found");
  }
  if (!metaRes.ok) {
    throw error(metaRes.status, `Failed to load artifact: ${metaRes.status}`);
  }
  const body = (await metaRes.json()) as {
    artifact?: {
      title?: string;
      data?: { mimeType?: string; originalName?: string };
      workspaceId?: string;
      chatId?: string;
    };
    contents?: string;
  };
  const artifact = body.artifact;
  if (!artifact) {
    throw error(500, "Artifact response missing metadata");
  }

  const mimeType = artifact.data?.mimeType ?? "application/octet-stream";
  const filename = artifact.data?.originalName ?? artifact.title ?? "artifact";
  const text = body.contents ?? "";
  const workspaceId = artifact.workspaceId;
  const chatId = artifact.chatId;

  const [workspaceName, chatTitle] = await Promise.all([
    workspaceId ? fetchWorkspaceName(workspaceId, fetchFn) : Promise.resolve(null),
    workspaceId && chatId ? fetchChatTitle(workspaceId, chatId, fetchFn) : Promise.resolve(null),
  ]);

  return {
    artifactId,
    mimeType,
    filename,
    text,
    contentUrl: `/api/daemon/api/artifacts/${encodeURIComponent(artifactId)}/content`,
    workspaceId: workspaceId ?? null,
    workspaceName,
    chatId: chatId ?? null,
    chatTitle,
  };
}

async function fetchWorkspaceName(
  workspaceId: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  try {
    const res = await fetchFn(`/api/daemon/api/workspaces/${encodeURIComponent(workspaceId)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      name?: string;
      config?: { workspace?: { name?: string } };
    };
    return body.config?.workspace?.name?.trim() || body.name?.trim() || null;
  } catch {
    return null;
  }
}

async function fetchChatTitle(
  workspaceId: string,
  chatId: string,
  fetchFn: typeof fetch,
): Promise<string | null> {
  try {
    const res = await fetchFn(
      `/api/daemon/api/workspaces/${encodeURIComponent(workspaceId)}/chat/${encodeURIComponent(chatId)}`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { chat?: { title?: string } };
    const title = body.chat?.title?.trim();
    return title && title.length > 0 ? title : null;
  } catch {
    return null;
  }
}

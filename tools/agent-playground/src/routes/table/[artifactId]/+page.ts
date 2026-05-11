import { error } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

/**
 * Load the raw bytes of a tabular artifact + the headers we need to
 * pick a parser. The actual parsing happens in the page component so
 * `DOMParser` (browser-only) is available — Sveltekit's universal
 * loader runs on both server and client and we want one code path.
 *
 * Also resolves provenance: the artifact's owning workspace name and
 * the chat it was snapshotted from (if any), so the page can render
 * "From <chat> in <workspace>" links back to the originating surfaces.
 * Both lookups are best-effort — a stale workspace id or a deleted
 * chat reduces to a missing name, never a page failure.
 *
 * Errors that should leave the user stranded (missing artifact, daemon
 * unreachable) throw via `error()` to surface SvelteKit's error page.
 * Parsing failures (the bytes are well-formed but not tabular in any
 * shape we recognize) are handled inline by the +page.svelte so the
 * user sees a graceful "this artifact isn't tabular" fallback with a
 * link to download the original.
 */
export const load: PageLoad = async ({ params, fetch }) => {
  const { artifactId } = params;
  if (!artifactId) {
    throw error(400, "Missing artifactId");
  }

  // Single round-trip: artifact metadata endpoint returns the file's
  // mimeType, originalName, workspaceId, chatId AND inlines the text
  // contents on the same response. /content endpoint would need a
  // second fetch with no advantage for our text-only consumer.
  const metaUrl = `/api/daemon/api/artifacts/${encodeURIComponent(artifactId)}`;
  const metaRes = await fetch(metaUrl);
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

  // Resolve display names for the provenance row in parallel — a
  // failure on either side leaves the link out of the rendered row
  // rather than wedging the page. The /content URL is preserved for
  // the "this isn't tabular" fallback's raw download link.
  const [workspaceName, chatTitle] = await Promise.all([
    workspaceId ? fetchWorkspaceName(workspaceId, fetch) : Promise.resolve(null),
    workspaceId && chatId ? fetchChatTitle(workspaceId, chatId, fetch) : Promise.resolve(null),
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
};

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
    // Workspace.yml's `workspace.name` is the user-edited display
    // name; daemon's top-level `name` is the registration label.
    // Prefer the config-side name when present so renames in
    // workspace.yml are reflected without a daemon restart.
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

import { error } from "@sveltejs/kit";
import { z } from "zod";
import { type AtlasUIMessage, validateAtlasUIMessages } from "@atlas/agent-sdk";
import { ArtifactSummarySchema } from "@atlas/core/artifacts";
import type { ArtifactPrefetch } from "$lib/components/chat/export-context";
import { GetChatResponseSchema } from "$lib/components/chat/types";
import type { PageServerLoad } from "./$types";

const ArtifactsResponseSchema = z.object({
  artifacts: z.array(ArtifactSummarySchema),
});

/**
 * Map an `ArtifactSummary` to the slim `ArtifactPrefetch` consumed by the
 * `ExportContext`. We deliberately drop fields ArtifactCard doesn't read
 * (revision, createdAt, slug, etc.) so the static HTML doesn't ship
 * extraneous bytes per artifact.
 */
function toArtifactPrefetch(
  summary: z.infer<typeof ArtifactSummarySchema>,
): ArtifactPrefetch {
  return {
    id: summary.id,
    title: summary.title,
    summary: summary.summary || undefined,
    mimeType: summary.mimeType,
    size: summary.size,
    originalName: summary.originalName,
  };
}

/**
 * Load the chat transcript and the chat's artifact metadata from the
 * daemon for the export-preview render. Both fetches are parallelized;
 * the chat fetch is the load-bearing one so its errors propagate, while
 * an artifact-list failure degrades gracefully to an empty list (the
 * preview still renders; ArtifactCards will surface a "missing from
 * export context" placeholder rather than failing the whole render).
 *
 * `event.fetch` routes through the in-process `/api/daemon/*` proxy, so
 * the daemon URL is owned by `$lib/daemon-url` and not duplicated here.
 */
export const load: PageServerLoad = async ({ params, fetch }) => {
  const workspaceId = params.workspaceId;
  const chatId = params.chatId;
  if (!workspaceId || !chatId) {
    throw error(400, "Missing workspaceId or chatId");
  }

  const wsPath = encodeURIComponent(workspaceId);
  const chatPath = encodeURIComponent(chatId);

  const [chatRes, artifactsRes] = await Promise.all([
    fetch(`/api/daemon/api/workspaces/${wsPath}/chat/${chatPath}?full=true`),
    // The chat-scoped artifact list endpoint (`/api/workspaces/:wsId/chat/:chatId/artifacts`)
    // referenced in the export design doc does not actually exist on the
    // daemon today — the only chat-filterable endpoint is the global
    // artifacts list with a `chatId` query param. T8's orchestrator will
    // either reuse this path or motivate adding a chat-scoped one; for
    // now we hit what's actually there.
    fetch(`/api/daemon/api/artifacts?chatId=${chatPath}`),
  ]);

  if (chatRes.status === 404) {
    throw error(404, "Chat not found");
  }
  if (!chatRes.ok) {
    throw error(502, `Daemon chat fetch failed: ${chatRes.status}`);
  }

  const chatJson: unknown = await chatRes.json();
  const chatParsed = GetChatResponseSchema.safeParse(chatJson);
  if (!chatParsed.success) {
    throw error(502, `Daemon chat response did not match schema: ${chatParsed.error.message}`);
  }
  // Re-validate at the boundary so `messages` arrives as `AtlasUIMessage[]`
  // and downstream `buildSegments` / `extractImages` calls don't need
  // wire-decode casts. The daemon already sanitises before responding,
  // so this is defence-in-depth, not load-bearing — but it's the cheapest
  // way to get a sound type without an `as` cast.
  const messages: AtlasUIMessage[] = await validateAtlasUIMessages(chatParsed.data.messages);

  let artifacts: ArtifactPrefetch[] = [];
  if (artifactsRes.ok) {
    const artifactsJson: unknown = await artifactsRes.json();
    const artifactsParsed = ArtifactsResponseSchema.safeParse(artifactsJson);
    if (artifactsParsed.success) {
      artifacts = artifactsParsed.data.artifacts.map(toArtifactPrefetch);
    } else {
      console.warn(
        "[export-preview] artifact list response did not match schema; rendering with empty artifact map",
        artifactsParsed.error.message,
      );
    }
  } else {
    console.warn(
      `[export-preview] artifact list fetch failed (${artifactsRes.status}); rendering with empty artifact map`,
    );
  }

  return {
    chat: chatParsed.data.chat,
    messages,
    artifacts,
  };
};

import { validateAtlasUIMessages } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { ArtifactWithContents } from "@atlas/core/artifacts";
import { redirect } from "@sveltejs/kit";
import { extractArtifactIds } from "$lib/utils/artifacts";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params }) => {
  const res = await parseResult(client.chat[":chatId"].$get({ param: { chatId: params.chatId } }));

  if (!res.ok) {
    // Chat not found or error - redirect to new chat
    redirect(302, "/");
  }

  const messages = await validateAtlasUIMessages(res.data.messages);

  // Batch-fetch artifacts referenced in messages to avoid N+1 calls during render
  const artifacts: Map<string, ArtifactWithContents> = new Map();
  const artifactIds = extractArtifactIds(messages);

  if (artifactIds.length > 0) {
    try {
      const batchRes = await parseResult(
        client.artifactsStorage["batch-get"].$post({
          json: { ids: artifactIds, includeContents: true },
        }),
      );

      if (batchRes.ok) {
        for (const artifact of batchRes.data.artifacts) {
          artifacts.set(artifact.id, artifact);
        }
      }
    } catch {
      // Graceful fallback - artifacts will be fetched individually during render
    }
  }

  return { title: res.data.chat.title, chatId: res.data.chat.id, messages, artifacts };
};

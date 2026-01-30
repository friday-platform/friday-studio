import { validateAtlasUIMessages } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { ArtifactWithContents } from "@atlas/core/artifacts";
import { randomColor } from "@atlas/utils";
import { redirect } from "@sveltejs/kit";
import { extractArtifactIds } from "$lib/utils/artifacts";
import { nanoid } from "$lib/utils/id";
import type { PageLoad } from "./$types";

export const load: PageLoad = async ({ params }) => {
  // New chat mode - generate ID at load time (not render time)
  // This makes chatId always a string, simplifying component logic
  if (!params.chatId) {
    return {
      chatId: `chat_${nanoid()}`,
      isNew: true,
      title: undefined,
      color: randomColor(),
      messages: [],
      artifacts: new Map<string, ArtifactWithContents>(),
    };
  }

  // Existing chat mode - fetch from storage
  const res = await parseResult(client.chat[":chatId"].$get({ param: { chatId: params.chatId } }));

  if (!res.ok) {
    // Chat not found or error - redirect to new chat
    throw redirect(302, "/chat");
  }

  const messages = await validateAtlasUIMessages(res.data.messages);

  // Batch-fetch artifacts referenced in messages to avoid N+1 calls during render
  const artifacts = new Map<string, ArtifactWithContents>();
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
      // Graceful fallback - artifacts will be fetched on demand
    }
  }

  return {
    chatId: res.data.chat.id,
    isNew: false,
    title: res.data.chat.title,
    color: res.data.chat.color,
    messages,
    artifacts,
  };
};

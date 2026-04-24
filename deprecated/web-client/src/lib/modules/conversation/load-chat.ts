import { validateAtlasUIMessages } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import type { ArtifactWithContents } from "@atlas/core/artifacts";
import { redirect } from "@sveltejs/kit";
import { extractArtifactIds } from "../../utils/artifacts.ts";
import { nanoid } from "../../utils/id.ts";

/**
 * Shared chat loader for both global and space chat routes.
 * Handles new chat creation, existing chat fetching, message validation,
 * and artifact batch-loading.
 *
 * @param chatId - Optional chat ID from route params. Undefined = new chat.
 * @param redirectPath - Where to redirect on fetch failure (e.g., "/chat" or "/spaces/:id/chat").
 */
export async function loadChat(chatId: string | undefined, redirectPath: string) {
  if (!chatId) {
    return {
      chatId: `chat_${nanoid()}`,
      isNew: true as const,
      title: undefined,
      messages: [] as never[],
      artifacts: new Map<string, ArtifactWithContents>(),
    };
  }

  const res = await parseResult(
    client.workspaceChat("user")[":chatId"].$get({ param: { chatId } }),
  );

  if (!res.ok) {
    const legacyRes = await parseResult(client.chat[":chatId"].$get({ param: { chatId } }));
    if (!legacyRes.ok) {
      throw redirect(302, redirectPath);
    }
    const messages = await validateAtlasUIMessages(legacyRes.data.messages);
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
      chatId: legacyRes.data.chat.id,
      isNew: false as const,
      title: legacyRes.data.chat.title,
      chat: legacyRes.data.chat,
      messages,
      artifacts,
    };
  }

  const messages = await validateAtlasUIMessages(res.data.messages);

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
    isNew: false as const,
    title: res.data.chat.title,
    chat: res.data.chat,
    messages,
    artifacts,
  };
}

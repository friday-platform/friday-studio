import { client, parseResult } from "@atlas/client/v2";

/**
 * Fetches workspace chats, sorted by updatedAt descending.
 */
export async function listWorkspaceChats(workspaceId: string, cursor: number | null) {
  const res = await parseResult(
    client
      .workspaceChat(workspaceId)
      .index.$get({ query: { limit: "25", cursor: cursor ? String(cursor) : undefined } }),
  );
  if (!res.ok) {
    throw new Error(`Failed to load workspace chats: ${res.error}`);
  }

  return res.data;
}

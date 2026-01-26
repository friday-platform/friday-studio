import { client, parseResult } from "@atlas/client/v2";

/**
 * Fetches the 25 most recent Atlas chats, sorted by updatedAt descending.
 * Filters to only return chats with source "atlas".
 */
export async function listChats(cursor: number | null) {
  const res = await parseResult(
    client.chat.index.$get({ query: { limit: "25", cursor: cursor ? String(cursor) : undefined } }),
  );
  if (!res.ok) {
    throw new Error(`Failed to load chats: ${res.error}`);
  }

  return res.data;
}

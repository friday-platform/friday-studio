import { client, parseResult } from "@atlas/client/v2";
import { goto } from "$app/navigation";
import { getContext, setContext } from "svelte";

const KEY = Symbol();

export interface ChatListItem {
  id: string;
  userId: string;
  workspaceId: string;
  source: "atlas" | "slack" | "discord";
  title?: string;
  createdAt: string;
  updatedAt: string;
}

class ChatContext {
  recentChats = $state<ChatListItem[]>([]);
  cursor = $state<number | null>(null);
  hasMoreChats = $state(true);
  isFetching = $state(false);

  async loadChats(options?: { reset?: boolean }): Promise<void> {
    const reset = options?.reset ?? !this.cursor;
    if (!reset && (!this.hasMoreChats || this.isFetching)) return;

    this.isFetching = true;
    try {
      const query: { limit: string; cursor?: string } = { limit: "25" };
      if (!reset && this.cursor) {
        query.cursor = String(this.cursor);
      }

      const res = await parseResult(client.chat.index.$get({ query }));
      if (!res.ok) {
        console.error("Failed to fetch chats:", res.error);
        return;
      }

      const atlasChats = res.data.chats.filter((chat) => chat.source === "atlas");
      this.recentChats = reset ? atlasChats : [...this.recentChats, ...atlasChats];
      this.cursor = res.data.nextCursor;
      this.hasMoreChats = res.data.hasMore;
    } finally {
      this.isFetching = false;
    }
  }

  startNewChat(): void {
    goto("/chat");
  }
}

export function setChatContext() {
  return setContext(KEY, new ChatContext());
}

export function getChatContext() {
  return getContext<ChatContext>(KEY);
}

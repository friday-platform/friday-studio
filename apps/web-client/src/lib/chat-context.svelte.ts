import { Chat } from "@ai-sdk/svelte";
import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { DefaultChatTransport } from "ai";
import { nanoid } from "nanoid";
import { getContext, setContext } from "svelte";
import { SvelteMap } from "svelte/reactivity";
import { goto } from "$app/navigation";
import { resolve } from "$app/paths";

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

  // Pagination state
  cursor = $state<number | null>(null);
  hasMoreChats = $state(true);
  isFetching = $state(false);

  // Saved chats cache (for /chat/[chatId] routes)
  chats = new SvelteMap<string, Chat<AtlasUIMessage>>();

  // New chat state (for / route)
  newChatId = $state<string>(nanoid());
  newChatMessages = $state<AtlasUIMessage[]>([]);

  newChat = $derived(
    new Chat({
      id: this.newChatId,
      messages: this.newChatMessages,
      onFinish: () => {
        this.loadChats({ reset: true });
        this.navigateToChat(this.newChatId);
      },
      transport: new DefaultChatTransport({
        api: `${getAtlasDaemonUrl()}/api/chat`,
        prepareSendMessagesRequest({ messages, id }) {
          return { body: { message: messages.at(-1), id } };
        },
      }),
    }),
  );

  /** Load chats - resets if no cursor, appends otherwise */
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

  /** Navigate to a saved chat */
  navigateToChat(chatId: string): void {
    goto(resolve("/chat/[chatId]", { chatId }));
  }

  /** Reset to a fresh new chat and navigate to / */
  resetNewChat(): void {
    this.newChatId = nanoid();
    this.newChatMessages = [];
    goto(resolve("/", {}));
  }
}

export function setChatContext() {
  const ctx = new ChatContext();

  return setContext(KEY, ctx);
}

export function getChatContext() {
  return getContext<ReturnType<typeof setChatContext>>(KEY);
}

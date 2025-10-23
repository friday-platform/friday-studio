import { Chat } from "@ai-sdk/svelte";
import { type AtlasUIMessage, validateAtlasUIMessages } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { DefaultChatTransport } from "ai";
import { getContext, setContext } from "svelte";

const KEY = Symbol();

export interface ChatListItem {
  id: string;
  userId: string;
  workspaceId: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
}

class ChatContext {
  id = $state<string>(crypto.randomUUID());
  previousMessages = $state<AtlasUIMessage[]>([]);
  recentChats = $state<ChatListItem[]>([]);

  chat = $derived(
    new Chat({
      id: this.id,
      messages: this.previousMessages,
      transport: new DefaultChatTransport({
        api: "http://localhost:8080/api/chat",
        prepareSendMessagesRequest({ messages, id }) {
          return { body: { message: messages.at(-1), id } };
        },
      }),
    }),
  );

  async loadRecentChats(): Promise<void> {
    const res = await parseResult(client.chat.index.$get());
    if (!res.ok) {
      console.error("Failed to fetch chats:", res.error);
      throw new Error(`Failed to fetch chats: ${JSON.stringify(res.error)}`);
    }

    this.recentChats = res.data.chats || [];
  }

  async loadChat(chatId: string): Promise<void> {
    const res = await parseResult(client.chat[":chatId"].$get({ param: { chatId } }));
    if (!res.ok) {
      console.error("Failed to load chat:", res.error);
      throw new Error(`Failed to load chat: ${JSON.stringify(res.error)}`);
    }

    this.id = chatId;
    this.previousMessages = await validateAtlasUIMessages(res.data.messages);
  }
}

export function setChatContext() {
  const ctx = new ChatContext();

  return setContext(KEY, ctx);
}

export function getChatContext() {
  return getContext<ReturnType<typeof setChatContext>>(KEY);
}

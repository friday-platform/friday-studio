import { Chat } from "@ai-sdk/svelte";
import { DefaultChatTransport } from "ai";
import { getContext, setContext } from "svelte";

const KEY = Symbol();

class ChatContext {
  chat = new Chat({
    id: crypto.randomUUID(),
    transport: new DefaultChatTransport({
      api: "http://localhost:8080/api/chat",
      prepareSendMessagesRequest({ messages, id }) {
        return { body: { message: messages.at(-1), id } };
      },
    }),
  });
}

export function setChatContext() {
  const ctx = new ChatContext();

  return setContext(KEY, ctx);
}

export function getChatContext() {
  return getContext<ReturnType<typeof setChatContext>>(KEY);
}

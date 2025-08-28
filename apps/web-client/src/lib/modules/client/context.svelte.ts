import type { SessionUIMessageChunk } from "@atlas/core";
import { readUIMessageStream, type UIDataTypes, type UIMessagePart, type UITools } from "ai";
import { getContext, setContext } from "svelte";
import { ConversationClient } from "./conversation.ts";
import type { DaemonClient } from "./daemon.ts";

const KEY = Symbol();

class ClientContext {
  client: DaemonClient;

  conversationClient: ConversationClient | null = null;
  conversationSessionId: string | null = null;
  sseAbortController: AbortController | null = null;
  sseStream: ReadableStream<SessionUIMessageChunk> | null = null;

  // Svelte reactive values
  typingState = $state({ isTyping: false, elapsedSeconds: 0 });
  messages = $state<UIMessagePart<UIDataTypes, UITools>[]>([]);
  user = $state<string>("NA");

  constructor(client: DaemonClient) {
    this.client = client;
  }

  getAtlasDaemonUrl() {
    return "http://localhost:8080";
  }

  async getUser() {
    if (!this.conversationClient) {
      return;
    }

    const data = await this.conversationClient.getUser();

    if (data.success) {
      this.user = data.currentUser;
    }
  }

  async setup() {
    try {
      // Use "atlas-conversation" as the workspace ID for the conversation system workspace
      this.conversationClient = new ConversationClient(
        this.getAtlasDaemonUrl(),
        "atlas-conversation",
        "cli-user",
      );

      const session = await this.conversationClient.createSession();

      this.conversationSessionId = session.sessionId;

      // Store the SSE URL for later use
      this.conversationClient.sseUrl = session.sseUrl;
      // this.conversationClient = newConversationClient;

      // Create AbortController for SSE
      this.sseAbortController = new AbortController();

      const stream = this.conversationClient.createMessageStream(
        this.conversationClient.sseUrl,
        this.sseAbortController?.signal,
      );

      this.sseStream = stream;

      this.getUser();

      for await (const uiMessage of readUIMessageStream({ stream })) {
        uiMessage.parts.forEach((part) => {
          if (part.type === "data-session-start" && !this.typingState.isTyping) {
            this.typingState.isTyping = true;
          } else if (part.type === "data-session-finish") {
            this.typingState.isTyping = false;
          }
        });

        this.messages = uiMessage.parts;

        // console.log(uiMessage.parts);
        // // Process messages with flatMap to handle typing indicator
        // this.output = uiMessage.parts.flatMap((part) => {
        //   const formattedMessage = formatMessage(part, user ?? "NA");

        //   // If this is a user message, check if there's a text message after it
        //   // if (part.type === "data-user-message") {
        //   //   const hasTextAfter = uiMessage.parts
        //   //     .slice(index + 1)
        //   //     .some((p) => p.type === "text" && p.state === "done");

        //   //   // Add typing indicator if no text message follows
        //   //   if (!hasTextAfter) {
        //   //     return formattedMessage
        //   //       ? [
        //   //           formattedMessage,
        //   //           { id: `typing-${uiMessage.id}-${index}`, type: "typing", role: "assistant" },
        //   //         ]
        //   //       : [];
        //   //   }
        //   // }

        //   return formattedMessage ? [formattedMessage] : [];
        // });
      }
    } catch (error) {
      // Clear any loading messages and show error
      const errorMessage = error instanceof Error ? error.message : String(error);

      console.error(`Failed to start Atlas daemon: ${errorMessage}`);
    }
  }
}

export function setClientContext(client: DaemonClient) {
  const ctx = new ClientContext(client);
  return setContext(KEY, ctx);
}

export function getClientContext() {
  return getContext<ReturnType<typeof setClientContext>>(KEY);
}

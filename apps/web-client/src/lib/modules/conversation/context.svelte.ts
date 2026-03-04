import type { Chat } from "@ai-sdk/svelte";
import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { getContext, setContext } from "svelte";
import type { Attachment } from "svelte/attachments";

const CONTEXT_KEY = Symbol("conversation-context");

export interface ConversationConfig {
  readonly chatId: string;
  readonly chat: Chat<AtlasUIMessage>;
  readonly handleStop: () => Promise<void>;
  readonly ready: boolean;
}

export class ConversationState {
  #config: ConversationConfig;

  message = $state("");
  textareaAdditionalSize = $state(1);
  userHasScrolled = $state(false);
  shouldScrollToEnd = $state(false);
  shouldScrollToStart = $state(false);
  turnStartedAt = $state<number | null>(null);

  constructor(config: ConversationConfig) {
    this.#config = config;
  }

  get chatId() {
    return this.#config.chatId;
  }
  get chat() {
    return this.#config.chat;
  }
  get handleStop() {
    return this.#config.handleStop;
  }
  get ready() {
    return this.#config.ready;
  }

  get hasMessages() {
    return this.chat.messages.length > 0;
  }

  resetScroll() {
    this.userHasScrolled = false;
    this.shouldScrollToEnd = true;
  }
}

export function setConversationContext(config: ConversationConfig) {
  return setContext(CONTEXT_KEY, new ConversationState(config));
}

export function getConversationContext() {
  return getContext<ConversationState>(CONTEXT_KEY);
}

export function scrollAttachment(
  disabled: boolean,
  context: ConversationState,
): Attachment<HTMLDivElement> {
  return (scrollContainer) => {
    let frameId: number | null = null;

    function continuouslyScrollToBottom(scrollContainer: HTMLDivElement) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;

      frameId = requestAnimationFrame(() => continuouslyScrollToBottom(scrollContainer));
    }

    function onScroll(e: Event) {
      const { scrollTop, scrollHeight, clientHeight } =
        e.currentTarget as unknown as HTMLDivElement;
      const isAtBottom = Math.abs(scrollHeight - scrollTop - clientHeight) < 5;

      context.userHasScrolled = !isAtBottom;
    }

    $effect(() => {
      if (context.ready) {
        context.userHasScrolled = false;
      }
    });

    $effect(() => {
      if (!context.ready || disabled) {
        if (frameId) {
          cancelAnimationFrame(frameId);
          frameId = null;
        }

        return;
      }

      if (context.userHasScrolled && frameId) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }

      if (!context.userHasScrolled && !frameId) {
        frameId = requestAnimationFrame(() => continuouslyScrollToBottom(scrollContainer));
      }

      return () => {
        if (frameId) {
          cancelAnimationFrame(frameId);
          frameId = null;
        }
      };
    });

    $effect(() => {
      if (context.shouldScrollToEnd) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;

        context.shouldScrollToEnd = false;
      }
    });

    $effect(() => {
      if (context.shouldScrollToStart) {
        scrollContainer.scrollTop = 0;

        context.shouldScrollToStart = false;
      }
    });

    $effect(() => {
      if (!disabled) {
        scrollContainer.addEventListener("scroll", onScroll);
      } else {
        context.shouldScrollToStart = true;
      }

      return () => {
        scrollContainer.removeEventListener("scroll", onScroll);
      };
    });
  };
}

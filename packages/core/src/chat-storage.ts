import type { SessionUIMessage } from "@atlas/core";

class ConversationStorage {
  private conversations = new Map<string, SessionUIMessage[]>();

  list(): string[] {
    return Array.from(this.conversations.keys());
  }

  get(streamId: string): SessionUIMessage[] {
    return this.conversations.get(streamId) || [];
  }

  append(streamId: string, message: SessionUIMessage): void {
    const messages = this.get(streamId);
    messages.push(message);
    this.conversations.set(streamId, messages);
  }

  replace(streamId: string, messages: SessionUIMessage[]): void {
    this.conversations.set(streamId, messages);
  }

  delete(streamId: string): boolean {
    return this.conversations.delete(streamId);
  }
}

export const conversationStorage = new ConversationStorage();

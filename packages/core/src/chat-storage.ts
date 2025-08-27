import { AtlasUIMessage } from "@atlas/agent-sdk";

class ConversationStorage {
  private conversations = new Map<string, AtlasUIMessage[]>();

  get(streamId: string): AtlasUIMessage[] {
    return this.conversations.get(streamId) || [];
  }

  append(streamId: string, message: AtlasUIMessage): void {
    const messages = this.get(streamId);
    messages.push(message);
    this.conversations.set(streamId, messages);
  }

  replace(streamId: string, messages: AtlasUIMessage[]): void {
    this.conversations.set(streamId, messages);
  }

  delete(streamId: string): boolean {
    return this.conversations.delete(streamId);
  }
}

export const conversationStorage = new ConversationStorage();

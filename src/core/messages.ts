import type { ITempestMessage, ITempestMessageManager, MessageUser } from "../types/core.ts";

export class MessageManager implements ITempestMessageManager {
  public history: ITempestMessage[] = [];

  newMessage(content: string, user: MessageUser): ITempestMessage {
    const message: ITempestMessage = {
      id: crypto.randomUUID(),
      promptUser: user,
      message: content,
      timestamp: new Date(),
    };

    this.history.push(message);
    return message;
  }

  editMessage(id: string, content: string): void {
    const message = this.history.find((m) => m.id === id);
    if (message) {
      message.message = content;
    }
  }

  getHistory(): ITempestMessage[] {
    return [...this.history];
  }

  getLastMessage(): ITempestMessage | undefined {
    return this.history[this.history.length - 1];
  }

  clear(): void {
    this.history = [];
  }
}

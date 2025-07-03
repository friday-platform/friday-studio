/**
 * Conversation History Storage for Atlas Conversation Agent
 *
 * This module provides conversation history management using Deno KV storage.
 * Each conversation is keyed by stream_id and maintains full message history.
 */

import { createDenoKVStorage, type DenoKVStorage } from "../storage/deno-kv-storage.ts";

export interface ConversationMessage {
  messageId: string;
  userId: string;
  content: string;
  timestamp: string;
  role: "user" | "assistant";
  metadata?: {
    streamId?: string;
    workspaceContext?: string;
    [key: string]: unknown;
  };
}

export interface ConversationHistory {
  streamId: string; // Primary key - this is the conversation identifier
  userId: string;
  messages: ConversationMessage[];
  createdAt: string;
  updatedAt: string;
  conversationId?: string; // Optional conversation ID for client continuity
  metadata?: {
    workspaceId?: string;
    scope?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

/**
 * Conversation storage manager that handles persistence of conversation history
 * using stream_id as the primary conversation identifier
 */
export class ConversationStorage {
  private kvStorage: DenoKVStorage | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(private kvPath?: string) {}

  /**
   * Initialize the KV storage connection
   */
  private async initialize(): Promise<void> {
    if (this.kvStorage) return;

    if (!this.initPromise) {
      this.initPromise = this._initialize();
    }

    return this.initPromise;
  }

  private async _initialize(): Promise<void> {
    try {
      // Create global KV storage for conversations
      this.kvStorage = await createDenoKVStorage(this.kvPath);
      console.log("[ConversationStorage] Initialized KV storage for conversations");
    } catch (error) {
      console.error("[ConversationStorage] Failed to initialize KV storage:", error);
      throw new Error(`Failed to initialize conversation storage: ${error.message}`);
    }
  }

  /**
   * Save a message to the conversation history
   */
  async saveMessage(streamId: string, message: ConversationMessage): Promise<void> {
    await this.initialize();

    try {
      // Get existing conversation or create new one
      const conversation = await this.getConversationHistory(streamId) || {
        streamId,
        userId: message.userId,
        messages: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      };

      // Add the new message
      conversation.messages.push(message);
      conversation.updatedAt = new Date().toISOString();

      // If this is the first message, set userId
      if (!conversation.userId) {
        conversation.userId = message.userId;
      }

      // Save updated conversation
      await this.kvStorage!.set(
        ["conversations", streamId],
        conversation,
      );

      // Also save individual message for potential querying
      await this.kvStorage!.set(
        ["conversations", streamId, "messages", message.messageId],
        message,
      );

      console.log(
        `[ConversationStorage] Saved message ${message.messageId} to conversation ${streamId}`,
      );
    } catch (error) {
      console.error(`[ConversationStorage] Failed to save message:`, error);
      throw new Error(`Failed to save conversation message: ${error.message}`);
    }
  }

  /**
   * Get complete conversation history by stream_id
   */
  async getConversationHistory(streamId: string): Promise<ConversationHistory | null> {
    await this.initialize();

    try {
      const conversation = await this.kvStorage!.get<ConversationHistory>(
        ["conversations", streamId],
      );

      if (conversation) {
        console.log(
          `[ConversationStorage] Retrieved conversation ${streamId} with ${conversation.messages.length} messages`,
        );
      }

      return conversation;
    } catch (error) {
      console.error(`[ConversationStorage] Failed to get conversation history:`, error);
      return null;
    }
  }

  /**
   * Get recent messages from a conversation (for context)
   */
  async getRecentMessages(streamId: string, limit = 10): Promise<ConversationMessage[]> {
    const conversation = await this.getConversationHistory(streamId);

    if (!conversation || !conversation.messages) {
      return [];
    }

    // Return the most recent messages (up to limit)
    return conversation.messages.slice(-limit);
  }

  /**
   * Update conversation metadata (like conversationId for client continuity)
   */
  async updateConversationMetadata(
    streamId: string,
    metadata: Partial<ConversationHistory["metadata"]>,
    conversationId?: string,
  ): Promise<void> {
    await this.initialize();

    try {
      const conversation = await this.getConversationHistory(streamId);
      if (!conversation) {
        console.warn(
          `[ConversationStorage] Attempted to update metadata for non-existent conversation: ${streamId}`,
        );
        return;
      }

      // Update metadata
      conversation.metadata = { ...conversation.metadata, ...metadata };
      conversation.updatedAt = new Date().toISOString();

      if (conversationId) {
        conversation.conversationId = conversationId;
      }

      await this.kvStorage!.set(
        ["conversations", streamId],
        conversation,
      );

      console.log(`[ConversationStorage] Updated metadata for conversation ${streamId}`);
    } catch (error) {
      console.error(`[ConversationStorage] Failed to update conversation metadata:`, error);
    }
  }

  /**
   * Format conversation history for LLM context
   */
  formatHistoryForContext(messages: ConversationMessage[]): string {
    if (!messages || messages.length === 0) {
      return "";
    }

    const formattedMessages = messages.map((msg) => {
      const role = msg.role === "user" ? "Human" : "Assistant";
      return `${role}: ${msg.content}`;
    }).join("\n\n");

    return `Previous conversation context:\n${formattedMessages}\n\nCurrent message:`;
  }

  /**
   * Check if conversation exists
   */
  async conversationExists(streamId: string): Promise<boolean> {
    const conversation = await this.getConversationHistory(streamId);
    return conversation !== null;
  }

  /**
   * Get conversation statistics
   */
  async getConversationStats(streamId: string): Promise<{
    messageCount: number;
    firstMessageAt?: string;
    lastMessageAt?: string;
    userId?: string;
  }> {
    const conversation = await this.getConversationHistory(streamId);

    if (!conversation) {
      return { messageCount: 0 };
    }

    return {
      messageCount: conversation.messages.length,
      firstMessageAt: conversation.createdAt,
      lastMessageAt: conversation.updatedAt,
      userId: conversation.userId,
    };
  }

  /**
   * Close the storage connection
   */
  async close(): Promise<void> {
    if (this.kvStorage) {
      await this.kvStorage.close();
      this.kvStorage = null;
      this.initPromise = null;
    }
  }
}

// Global conversation storage instance
let globalConversationStorage: ConversationStorage | null = null;

/**
 * Get or create the global conversation storage instance
 */
export function getConversationStorage(): ConversationStorage {
  if (!globalConversationStorage) {
    // Use a specific file path for shared conversation storage across all workers
    const conversationStoragePath = Deno.env.get("ATLAS_CONVERSATION_KV_PATH") ||
      `${Deno.env.get("HOME")}/.atlas/conversations.db`;
    globalConversationStorage = new ConversationStorage(conversationStoragePath);
  }
  return globalConversationStorage;
}

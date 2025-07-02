/**
 * Conversation Draft Storage Adapter
 *
 * This adapter extends the WorkspaceDraftStorageAdapter to add conversation-specific
 * functionality. It scopes drafts by conversation ID and provides conversation-aware
 * draft management for the workspace creation workflow.
 */

import {
  type WorkspaceDraft,
  WorkspaceDraftStorageAdapter,
} from "./workspace-draft-storage-adapter.ts";
import type { KVStorage } from "./kv-storage.ts";
import type { WorkspaceConfig } from "@atlas/config";

export interface ConversationDraft extends WorkspaceDraft {
  conversationId: string;
  messageContext?: {
    lastUserMessage?: string;
    lastAssistantResponse?: string;
    timestamp?: string;
  };
}

/**
 * Conversation-scoped draft storage operations
 *
 * This adapter provides conversation-aware workspace draft operations,
 * ensuring drafts are properly scoped and tracked within conversation contexts.
 */
export class ConversationDraftAdapter {
  private draftAdapter: WorkspaceDraftStorageAdapter;

  constructor(private storage: KVStorage) {
    this.draftAdapter = new WorkspaceDraftStorageAdapter(storage);
  }

  /**
   * Initialize the conversation draft storage
   */
  async initialize(): Promise<void> {
    await this.draftAdapter.initialize();

    // Initialize conversation-specific metadata if not exists
    const version = await this.storage.get<string>(["conversation_draft_metadata", "version"]);
    if (!version) {
      const atomic = this.storage.atomic();
      atomic.set(["conversation_draft_metadata", "version"], "1.0.0");
      atomic.set(["conversation_draft_metadata", "lastUpdated"], new Date().toISOString());
      await atomic.commit();
    }
  }

  /**
   * Create a new workspace draft within a conversation context
   */
  async createDraft(params: {
    name: string;
    description: string;
    conversationId: string;
    sessionId: string;
    userId: string;
    initialConfig?: Partial<WorkspaceConfig>;
    messageContext?: ConversationDraft["messageContext"];
  }): Promise<ConversationDraft> {
    // Create the base draft using the underlying adapter
    const baseDraft = await this.draftAdapter.createDraft({
      name: params.name,
      description: params.description,
      sessionId: params.sessionId,
      userId: params.userId,
      initialConfig: params.initialConfig,
    });

    // Extend with conversation-specific fields
    const conversationDraft: ConversationDraft = {
      ...baseDraft,
      conversationId: params.conversationId,
      messageContext: params.messageContext,
    };

    // Store the conversation-scoped draft
    const atomic = this.storage.atomic();
    atomic.set(["conversation_drafts", conversationDraft.id], conversationDraft);
    atomic.set(
      ["conversation_drafts_by_conversation", params.conversationId, conversationDraft.id],
      conversationDraft.id,
    );
    atomic.set(["conversation_draft_metadata", "lastUpdated"], new Date().toISOString());

    const success = await atomic.commit();
    if (!success) {
      throw new Error("Failed to create conversation draft - atomic operation failed");
    }

    return conversationDraft;
  }

  /**
   * Update a workspace draft with conversation context
   */
  async updateDraft(
    draftId: string,
    updates: Partial<WorkspaceConfig>,
    updateDescription: string,
    messageContext?: ConversationDraft["messageContext"],
  ): Promise<ConversationDraft> {
    // Update the base draft
    const updatedDraft = await this.draftAdapter.updateDraft(draftId, updates, updateDescription);

    // Get the conversation draft to maintain conversation context
    const conversationDraft = await this.getConversationDraft(draftId);
    if (!conversationDraft) {
      throw new Error(`Conversation draft ${draftId} not found`);
    }

    // Update with new message context if provided
    if (messageContext) {
      conversationDraft.messageContext = messageContext;
    }

    // Merge the updated base draft with conversation fields
    const updated: ConversationDraft = {
      ...updatedDraft,
      conversationId: conversationDraft.conversationId,
      messageContext: conversationDraft.messageContext,
    };

    // Store the updated conversation draft
    const atomic = this.storage.atomic();
    atomic.set(["conversation_drafts", draftId], updated);
    atomic.set(["conversation_draft_metadata", "lastUpdated"], new Date().toISOString());

    const success = await atomic.commit();
    if (!success) {
      throw new Error(`Failed to update conversation draft ${draftId} - atomic operation failed`);
    }

    return updated;
  }

  /**
   * Get a conversation draft by ID
   */
  async getConversationDraft(draftId: string): Promise<ConversationDraft | null> {
    return await this.storage.get<ConversationDraft>(["conversation_drafts", draftId]);
  }

  /**
   * Get the underlying workspace draft (without conversation context)
   */
  async getDraft(draftId: string): Promise<WorkspaceDraft | null> {
    return await this.draftAdapter.getDraft(draftId);
  }

  /**
   * Get all drafts for a conversation
   */
  async getConversationDrafts(conversationId: string): Promise<ConversationDraft[]> {
    const drafts: ConversationDraft[] = [];

    // List all draft IDs for this conversation
    for await (
      const { value: draftId } of this.storage.list<string>([
        "conversation_drafts_by_conversation",
        conversationId,
      ])
    ) {
      if (draftId) {
        const draft = await this.getConversationDraft(draftId);
        if (draft && draft.status === "draft") {
          drafts.push(draft);
        }
      }
    }

    return drafts;
  }

  /**
   * Get all drafts for a session (delegated to base adapter)
   */
  async getSessionDrafts(sessionId: string): Promise<WorkspaceDraft[]> {
    return await this.draftAdapter.getSessionDrafts(sessionId);
  }

  /**
   * Mark a draft as published
   */
  async publishDraft(draftId: string): Promise<void> {
    // Mark as published in base adapter
    await this.draftAdapter.publishDraft(draftId);

    // Update conversation draft status
    const conversationDraft = await this.getConversationDraft(draftId);
    if (conversationDraft) {
      conversationDraft.status = "published";
      conversationDraft.updatedAt = new Date().toISOString();

      const atomic = this.storage.atomic();
      atomic.set(["conversation_drafts", draftId], conversationDraft);
      atomic.set(["conversation_draft_metadata", "lastUpdated"], new Date().toISOString());

      const success = await atomic.commit();
      if (!success) {
        throw new Error(
          `Failed to update conversation draft status ${draftId} - atomic operation failed`,
        );
      }
    }
  }

  /**
   * Get conversation-specific statistics
   */
  async getConversationStats(conversationId: string): Promise<{
    totalDrafts: number;
    publishedDrafts: number;
    lastActivity: string | null;
  }> {
    const stats = {
      totalDrafts: 0,
      publishedDrafts: 0,
      lastActivity: null as string | null,
    };

    const drafts = await this.getConversationDrafts(conversationId);
    stats.totalDrafts = drafts.length;
    stats.publishedDrafts = drafts.filter((d) => d.status === "published").length;

    if (drafts.length > 0) {
      const latestDraft = drafts.reduce((latest, draft) =>
        new Date(draft.updatedAt) > new Date(latest.updatedAt) ? draft : latest
      );
      stats.lastActivity = latestDraft.updatedAt;
    }

    return stats;
  }

  /**
   * Close the storage adapter
   */
  async close(): Promise<void> {
    await this.draftAdapter.close();
  }

  /**
   * Get the underlying storage for advanced operations
   */
  getStorage(): KVStorage {
    return this.storage;
  }
}

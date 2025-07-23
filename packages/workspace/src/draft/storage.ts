/**
 * Draft Storage - Core CRUD operations for workspace drafts
 */

import type { WorkspaceConfig } from "@atlas/config";
import type { KVStorage } from "../../../../src/core/storage/index.ts";
import type { WorkspaceDraft } from "../types.ts";
import { DraftLockManager } from "./locking.ts";

export class WorkspaceDraftStore {
  private readonly DRAFT_VERSION = "1.0.0";
  private readonly lockManager: DraftLockManager;

  constructor(private storage: KVStorage) {
    this.lockManager = new DraftLockManager(storage);
  }

  async initialize(): Promise<void> {
    await this.storage.initialize();

    // Initialize draft metadata if not exists
    const version = await this.storage.get<string>(["draft_metadata", "version"]);
    if (!version) {
      const atomic = this.storage.atomic();
      atomic.set(["draft_metadata", "version"], this.DRAFT_VERSION);
      atomic.set(["draft_metadata", "lastUpdated"], new Date().toISOString());
      await atomic.commit();
    }
  }

  async createDraft(params: {
    name: string;
    description: string;
    pattern?: string;
    sessionId: string;
    conversationId?: string;
    userId: string;
    initialConfig?: Partial<WorkspaceConfig>;
  }): Promise<WorkspaceDraft> {
    // Start with minimal base config
    const baseConfig: Partial<WorkspaceConfig> = {
      version: "1.0",
      workspace: {
        name: params.name,
        description: params.description,
      },
    };

    // Merge initial config directly
    let config: Partial<WorkspaceConfig>;
    if (params.initialConfig) {
      config = this.deepMerge(baseConfig, params.initialConfig);
    } else {
      config = baseConfig;
    }

    const draft: WorkspaceDraft = {
      id: crypto.randomUUID(),
      name: params.name,
      description: params.description,
      config,
      iterations: params.initialConfig
        ? [{
          timestamp: new Date().toISOString(),
          operation: "initial_config",
          config: params.initialConfig,
          summary: "Created with initial configuration",
        }]
        : [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "draft",
      sessionId: params.sessionId,
      conversationId: params.conversationId,
      userId: params.userId,
    };

    // Atomic operation to create draft and update indexes
    const atomic = this.storage.atomic();
    atomic.set(["workspace_drafts", draft.id], draft);
    atomic.set(["workspace_drafts_by_session", params.sessionId, draft.id], draft.id);
    atomic.set(["draft_metadata", "lastUpdated"], new Date().toISOString());

    // Index by conversation if provided
    if (params.conversationId) {
      atomic.set(["workspace_drafts_by_conversation", params.conversationId, draft.id], draft.id);
    }

    const success = await atomic.commit();
    if (!success) {
      throw new Error("Failed to create draft - atomic operation failed");
    }

    return draft;
  }

  async updateDraft(
    draftId: string,
    updates: Partial<WorkspaceConfig>,
    updateDescription: string,
  ): Promise<WorkspaceDraft> {
    const currentDraft = await this.getDraft(draftId);
    if (!currentDraft) {
      throw new Error(`Draft ${draftId} not found`);
    }

    // Create a deep copy for modification
    const updatedDraft: WorkspaceDraft = JSON.parse(JSON.stringify(currentDraft));

    // Deep merge the updates into existing config
    updatedDraft.config = this.deepMerge(updatedDraft.config, updates);

    // Add to iteration history
    updatedDraft.iterations.push({
      timestamp: new Date().toISOString(),
      operation: "update_config",
      config: updates,
      summary: updateDescription,
    });

    updatedDraft.updatedAt = new Date().toISOString();

    // Atomic update
    const atomic = this.storage.atomic();
    atomic.set(["workspace_drafts", draftId], updatedDraft);
    atomic.set(["draft_metadata", "lastUpdated"], new Date().toISOString());

    const success = await atomic.commit();
    if (!success) {
      throw new Error(`Failed to update draft ${draftId} - atomic operation failed`);
    }

    return updatedDraft;
  }

  async publishDraft(draftId: string): Promise<void> {
    const currentDraft = await this.getDraft(draftId);
    if (!currentDraft) {
      throw new Error(`Draft ${draftId} not found`);
    }

    // Create a copy for modification
    const updatedDraft = { ...currentDraft };
    updatedDraft.status = "published";
    updatedDraft.updatedAt = new Date().toISOString();

    const atomic = this.storage.atomic();
    atomic.set(["workspace_drafts", draftId], updatedDraft);
    atomic.set(["draft_metadata", "lastUpdated"], new Date().toISOString());

    const success = await atomic.commit();
    if (!success) {
      throw new Error(`Failed to publish draft ${draftId} - atomic operation failed`);
    }
  }

  async getSessionDrafts(sessionId: string): Promise<WorkspaceDraft[]> {
    const drafts: WorkspaceDraft[] = [];

    // List all draft IDs for this session
    for await (
      const { value: draftId } of this.storage.list<string>([
        "workspace_drafts_by_session",
        sessionId,
      ])
    ) {
      if (draftId) {
        const draft = await this.getDraft(draftId);
        if (draft && draft.status === "draft") {
          drafts.push(draft);
        }
      }
    }

    return drafts;
  }

  async getConversationDrafts(conversationId: string): Promise<WorkspaceDraft[]> {
    const drafts: WorkspaceDraft[] = [];

    for await (
      const { value: draftId } of this.storage.list<string>([
        "workspace_drafts_by_conversation",
        conversationId,
      ])
    ) {
      if (draftId) {
        const draft = await this.getDraft(draftId);
        if (draft) {
          drafts.push(draft);
        }
      }
    }

    // Sort by creation time (newest first)
    return drafts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async getDraft(draftId: string): Promise<WorkspaceDraft | null> {
    return await this.storage.get<WorkspaceDraft>(["workspace_drafts", draftId]);
  }

  async deleteDraft(draftId: string): Promise<void> {
    const draft = await this.getDraft(draftId);

    if (!draft) {
      throw new Error(`Draft ${draftId} not found`);
    }

    // Use atomic operation to ensure consistency
    const atomic = this.storage.atomic();

    // Delete main draft entry
    atomic.delete(["workspace_drafts", draftId]);

    // Delete from session index
    atomic.delete(["workspace_drafts_by_session", draft.sessionId, draftId]);

    // Delete from conversation index if exists
    if (draft.conversationId) {
      atomic.delete(["workspace_drafts_by_conversation", draft.conversationId, draftId]);
    }

    // Delete any existing locks
    atomic.delete(["draft_locks", draftId]);

    const success = await atomic.commit();
    if (!success) {
      throw new Error("Failed to delete draft - atomic operation failed");
    }
  }

  private deepMerge(
    target: Partial<WorkspaceConfig>,
    source: Partial<WorkspaceConfig>,
  ): Partial<WorkspaceConfig> {
    const result: Record<string, unknown> = { ...target };

    for (const key in source) {
      const sourceValue = source[key as keyof WorkspaceConfig];
      const targetValue = target[key as keyof WorkspaceConfig];

      if (sourceValue === null || sourceValue === undefined) {
        // Skip null/undefined values
        continue;
      }

      if (Array.isArray(sourceValue)) {
        // Arrays replace completely (typical for workspace configs)
        result[key] = [...sourceValue];
      } else if (
        sourceValue &&
        typeof sourceValue === "object" &&
        targetValue &&
        typeof targetValue === "object" &&
        !Array.isArray(targetValue)
      ) {
        // Special handling for key workspace config sections
        if (key === "agents" || key === "jobs" || key === "signals" || key === "tools") {
          // For agents/jobs/signals, deep merge each entity by ID/name keys
          const targetObj = targetValue as Record<string, unknown>;
          const sourceObj = sourceValue as Record<string, unknown>;
          const mergedObj: Record<string, unknown> = { ...targetObj };

          // For each key in source, deep merge with target
          for (const entityKey in sourceObj) {
            const sourceEntity = sourceObj[entityKey];
            const targetEntity = targetObj[entityKey];

            if (
              targetEntity && typeof targetEntity === "object" &&
              sourceEntity && typeof sourceEntity === "object" &&
              !Array.isArray(targetEntity) && !Array.isArray(sourceEntity)
            ) {
              // Deep merge the entity
              mergedObj[entityKey] = this.deepMergeObjects(
                targetEntity as Record<string, unknown>,
                sourceEntity as Record<string, unknown>,
              );
            } else {
              // Direct assignment for new entities or non-objects
              mergedObj[entityKey] = sourceEntity;
            }
          }

          result[key] = mergedObj;
        } else {
          // Recursively merge other objects
          result[key] = this.deepMergeObjects(
            targetValue as Record<string, unknown>,
            sourceValue as Record<string, unknown>,
          );
        }
      } else {
        // Direct assignment for primitives
        result[key] = sourceValue;
      }
    }

    return result as Partial<WorkspaceConfig>;
  }

  private deepMergeObjects(
    target: Record<string, unknown>,
    source: Record<string, unknown>,
  ): Record<string, unknown> {
    const result = { ...target };

    for (const key in source) {
      const sourceValue = source[key];
      const targetValue = target[key];

      if (sourceValue === null || sourceValue === undefined) {
        continue;
      }

      if (Array.isArray(sourceValue)) {
        result[key] = [...sourceValue];
      } else if (
        sourceValue &&
        typeof sourceValue === "object" &&
        targetValue &&
        typeof targetValue === "object" &&
        !Array.isArray(targetValue)
      ) {
        result[key] = this.deepMergeObjects(
          targetValue as Record<string, unknown>,
          sourceValue as Record<string, unknown>,
        );
      } else {
        result[key] = sourceValue;
      }
    }

    return result;
  }

  async close(): Promise<void> {
    await this.storage.close();
  }

  /**
   * Update draft with locking for safe concurrent access
   */
  async updateDraftWithLock(
    draftId: string,
    updates: Partial<WorkspaceConfig>,
    updateDescription: string,
    lockedBy: string,
    timeoutMs: number = 30 * 1000,
  ): Promise<WorkspaceDraft> {
    // Acquire lock for update operation
    const lockResult = await this.lockManager.acquireDraftLock(
      draftId,
      lockedBy,
      `update_config: ${updateDescription}`,
      timeoutMs,
    );

    if (!lockResult.success) {
      throw new Error(`Failed to acquire lock for draft ${draftId}: ${lockResult.error}`);
    }

    try {
      // Perform the update operation
      return await this.updateDraft(draftId, updates, updateDescription);
    } finally {
      // Always release the lock, even if update fails
      await this.lockManager.releaseDraftLock(draftId, lockedBy);
    }
  }

  /**
   * Acquire a lock on a draft for exclusive access
   */
  async acquireDraftLock(
    draftId: string,
    lockedBy: string,
    operation: string,
    timeoutMs: number = 5 * 60 * 1000,
  ) {
    return await this.lockManager.acquireDraftLock(draftId, lockedBy, operation, timeoutMs);
  }

  /**
   * Release a draft lock
   */
  async releaseDraftLock(draftId: string, lockedBy: string): Promise<boolean> {
    return await this.lockManager.releaseDraftLock(draftId, lockedBy);
  }

  getStorage(): KVStorage {
    return this.storage;
  }
}

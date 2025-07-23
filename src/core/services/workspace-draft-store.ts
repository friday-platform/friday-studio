import type { WorkspaceConfig } from "@atlas/config";

export interface WorkspaceDraft {
  id: string;
  name: string;
  description: string;
  config: Partial<WorkspaceConfig>;
  iterations: Array<{
    timestamp: string;
    operation: string;
    config: Record<string, unknown>;
    summary: string;
  }>;
  createdAt: string;
  updatedAt: string;
  status: "draft" | "published" | "abandoned";
  sessionId: string;
  conversationId?: string; // NEW: Track conversation context for drafts
  userId: string;
}

export interface DraftLock {
  draftId: string;
  lockedBy: string; // Session ID or user ID that holds the lock
  lockedAt: string; // ISO timestamp when lock was acquired
  expiresAt: string; // ISO timestamp when lock expires
  operation: string; // Description of the operation being performed
}

export interface LockResult {
  success: boolean;
  lock?: DraftLock;
  error?: string;
}

export class WorkspaceDraftStore {
  private kv: Deno.Kv;

  constructor(kv: Deno.Kv) {
    this.kv = kv;
  }

  async createDraft(params: {
    name: string;
    description: string;
    pattern?: string;
    sessionId: string;
    conversationId?: string; // NEW: Optional conversation ID for grouping drafts
    userId: string;
    initialConfig?: Partial<WorkspaceConfig>; // NEW: Accept initial config
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

    const key = ["workspace_drafts", draft.id];
    await this.kv.set(key, draft);

    // Index by session
    const sessionKey = ["workspace_drafts_by_session", params.sessionId, draft.id];
    await this.kv.set(sessionKey, draft.id);

    // Index by conversation if provided
    if (params.conversationId) {
      const conversationKey = ["workspace_drafts_by_conversation", params.conversationId, draft.id];
      await this.kv.set(conversationKey, draft.id);
    }

    return draft;
  }

  async updateDraft(
    draftId: string,
    updates: Partial<WorkspaceConfig>,
    updateDescription: string,
  ): Promise<WorkspaceDraft> {
    const key = ["workspace_drafts", draftId];
    const entry = await this.kv.get<WorkspaceDraft>(key);

    if (!entry.value) {
      throw new Error(`Draft ${draftId} not found`);
    }

    const draft = entry.value;

    // Deep merge the updates into existing config
    draft.config = this.deepMerge(draft.config, updates);

    // Add to iteration history
    draft.iterations.push({
      timestamp: new Date().toISOString(),
      operation: "update_config",
      config: updates,
      summary: updateDescription,
    });

    draft.updatedAt = new Date().toISOString();
    await this.kv.set(key, draft);
    return draft;
  }

  /**
   * Update draft with locking for safe concurrent access
   * This is the recommended method for updating drafts in concurrent environments
   *
   * @param draftId - The draft to update
   * @param updates - Configuration updates to apply
   * @param updateDescription - Description of the changes being made
   * @param lockedBy - Identifier for who is making the update (session/user ID)
   * @param timeoutMs - Lock timeout in milliseconds
   * @returns Updated draft or throws error if lock cannot be acquired
   */
  async updateDraftWithLock(
    draftId: string,
    updates: Partial<WorkspaceConfig>,
    updateDescription: string,
    lockedBy: string,
    timeoutMs: number = 30 * 1000, // 30 seconds for update operations
  ): Promise<WorkspaceDraft> {
    // Acquire lock for update operation
    const lockResult = await this.acquireDraftLock(
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
      await this.releaseDraftLock(draftId, lockedBy);
    }
  }

  async publishDraft(draftId: string): Promise<void> {
    const key = ["workspace_drafts", draftId];
    const entry = await this.kv.get<WorkspaceDraft>(key);

    if (!entry.value) {
      throw new Error(`Draft ${draftId} not found`);
    }

    const draft = entry.value;
    draft.status = "published";
    draft.updatedAt = new Date().toISOString();

    await this.kv.set(key, draft);
  }

  async getSessionDrafts(sessionId: string): Promise<WorkspaceDraft[]> {
    const drafts: WorkspaceDraft[] = [];
    const prefix = ["workspace_drafts_by_session", sessionId];

    for await (const entry of this.kv.list({ prefix })) {
      const draftId = entry.value as string;
      const draftEntry = await this.kv.get<WorkspaceDraft>(["workspace_drafts", draftId]);
      if (draftEntry.value && draftEntry.value.status === "draft") {
        drafts.push(draftEntry.value);
      }
    }

    return drafts;
  }

  /**
   * Get all drafts for a specific conversation
   * Returns drafts sorted by creation time (newest first)
   */
  async getConversationDrafts(conversationId: string): Promise<WorkspaceDraft[]> {
    const drafts: WorkspaceDraft[] = [];
    const prefix = ["workspace_drafts_by_conversation", conversationId];

    for await (const entry of this.kv.list({ prefix })) {
      const draftId = entry.value as string;
      const draftEntry = await this.kv.get<WorkspaceDraft>(["workspace_drafts", draftId]);
      if (draftEntry.value) {
        drafts.push(draftEntry.value);
      }
    }

    // Sort by creation time (newest first)
    return drafts.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * Get the most recent draft for a conversation (by creation time)
   */
  async getLatestConversationDraft(conversationId: string): Promise<WorkspaceDraft | null> {
    const drafts = await this.getConversationDrafts(conversationId);
    return drafts.length > 0 ? drafts[0] : null;
  }

  /**
   * Count drafts by conversation
   */
  async countConversationDrafts(conversationId: string): Promise<number> {
    let count = 0;
    const prefix = ["workspace_drafts_by_conversation", conversationId];

    for await (const _entry of this.kv.list({ prefix })) {
      count++;
    }

    return count;
  }

  async getDraft(draftId: string): Promise<WorkspaceDraft | null> {
    const key = ["workspace_drafts", draftId];
    const entry = await this.kv.get<WorkspaceDraft>(key);
    return entry.value;
  }

  /**
   * Delete a draft and all its associated data
   * Removes from both main storage and session indexes
   */
  async deleteDraft(draftId: string): Promise<void> {
    const key = ["workspace_drafts", draftId];
    const entry = await this.kv.get<WorkspaceDraft>(key);

    if (!entry.value) {
      throw new Error(`Draft ${draftId} not found`);
    }

    const draft = entry.value;

    // Use atomic operation to ensure consistency
    const atomic = this.kv.atomic();

    // Delete main draft entry
    atomic.delete(key);

    // Delete from session index
    const sessionKey = ["workspace_drafts_by_session", draft.sessionId, draftId];
    atomic.delete(sessionKey);

    // Delete from conversation index if exists
    if (draft.conversationId) {
      const conversationKey = ["workspace_drafts_by_conversation", draft.conversationId, draftId];
      atomic.delete(conversationKey);
    }

    // Delete any existing locks
    const lockKey = ["draft_locks", draftId];
    atomic.delete(lockKey);

    const success = await atomic.commit();
    if (!success) {
      throw new Error("Failed to delete draft - atomic operation failed");
    }
  }

  /**
   * Acquire a lock on a draft for exclusive access
   *
   * @param draftId - The draft to lock
   * @param lockedBy - Identifier for who is locking (session/user ID)
   * @param operation - Description of the operation being performed
   * @param timeoutMs - Lock timeout in milliseconds (default: 5 minutes)
   * @returns LockResult indicating success/failure
   */
  async acquireDraftLock(
    draftId: string,
    lockedBy: string,
    operation: string,
    timeoutMs: number = 5 * 60 * 1000, // 5 minutes default
  ): Promise<LockResult> {
    const lockKey = ["draft_locks", draftId];
    const now = new Date();
    const expiresAt = new Date(now.getTime() + timeoutMs);

    // Check if draft exists
    const draftKey = ["workspace_drafts", draftId];
    const draftEntry = await this.kv.get<WorkspaceDraft>(draftKey);
    if (!draftEntry.value) {
      return {
        success: false,
        error: `Draft ${draftId} not found`,
      };
    }

    // Try to acquire lock atomically
    const lock: DraftLock = {
      draftId,
      lockedBy,
      lockedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      operation,
    };

    // Use atomic operation to check and set lock
    const existingLockEntry = await this.kv.get<DraftLock>(lockKey);
    const existingLock = existingLockEntry.value;

    // If lock exists and hasn't expired, check if it's the same holder
    if (existingLock) {
      const lockExpiry = new Date(existingLock.expiresAt);

      if (lockExpiry > now) {
        // Lock is still valid
        if (existingLock.lockedBy === lockedBy) {
          // Same holder - extend the lock
          const extendedLock: DraftLock = {
            ...existingLock,
            expiresAt: expiresAt.toISOString(),
            operation, // Update operation description
          };

          await this.kv.set(lockKey, extendedLock);
          return {
            success: true,
            lock: extendedLock,
          };
        } else {
          // Different holder - lock is taken
          return {
            success: false,
            error:
              `Draft is locked by ${existingLock.lockedBy} until ${existingLock.expiresAt} for operation: ${existingLock.operation}`,
          };
        }
      }
      // Lock has expired - will be overwritten below
    }

    // Set new lock
    await this.kv.set(lockKey, lock);
    return {
      success: true,
      lock,
    };
  }

  /**
   * Release a draft lock
   *
   * @param draftId - The draft to unlock
   * @param lockedBy - Identifier for who is unlocking (must match lock holder)
   * @returns true if lock was released, false if not found or not owned by caller
   */
  async releaseDraftLock(draftId: string, lockedBy: string): Promise<boolean> {
    const lockKey = ["draft_locks", draftId];
    const lockEntry = await this.kv.get<DraftLock>(lockKey);

    if (!lockEntry.value) {
      return false; // No lock exists
    }

    const lock = lockEntry.value;
    if (lock.lockedBy !== lockedBy) {
      return false; // Lock owned by different holder
    }

    await this.kv.delete(lockKey);
    return true;
  }

  /**
   * Check if a draft is currently locked
   *
   * @param draftId - The draft to check
   * @returns DraftLock if locked and not expired, null otherwise
   */
  async getDraftLock(draftId: string): Promise<DraftLock | null> {
    const lockKey = ["draft_locks", draftId];
    const lockEntry = await this.kv.get<DraftLock>(lockKey);

    if (!lockEntry.value) {
      return null;
    }

    const lock = lockEntry.value;
    const now = new Date();
    const expiresAt = new Date(lock.expiresAt);

    if (expiresAt <= now) {
      // Lock has expired - clean it up
      await this.kv.delete(lockKey);
      return null;
    }

    return lock;
  }

  /**
   * Clean up expired locks
   * This can be called periodically to remove stale lock entries
   */
  async cleanupExpiredLocks(): Promise<number> {
    let cleanedCount = 0;
    const now = new Date();
    const prefix = ["draft_locks"];

    for await (const entry of this.kv.list({ prefix })) {
      const lock = entry.value as DraftLock;
      const expiresAt = new Date(lock.expiresAt);

      if (expiresAt <= now) {
        await this.kv.delete(entry.key);
        cleanedCount++;
      }
    }

    return cleanedCount;
  }

  private generateOperationSummary(operation: string, config: Record<string, unknown>): string {
    switch (operation) {
      case "add_agent": {
        // Handle both old format (id/purpose) and new format (name/description)
        const agentName = config.id || config.name || "unnamed";
        const agentPurpose = config.purpose || config.description || "unspecified";
        return `Added agent '${agentName}' with purpose: ${agentPurpose}`;
      }
      case "update_agent":
        return `Updated agent '${config.id || config.name}'`;
      case "add_job":
        return `Created job '${config.id || config.name}' to coordinate agents`;
      case "set_trigger":
        return `Configured ${config.provider} trigger for the workspace`;
      case "add_tool":
        return `Added ${config.provider} tool provider`;
      default:
        return `Applied ${operation} to workspace configuration`;
    }
  }

  /**
   * Deep merge workspace configurations with proper handling of arrays and nested objects
   *
   * Merge strategy:
   * - Objects: Recursively merge properties
   * - Arrays: Replace completely (workspace configs typically want replacement, not concat)
   * - Primitives: Source overwrites target
   * - Special handling for agents/jobs/signals objects to merge by key
   */
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

  /**
   * Helper method for deep merging generic objects
   */
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
}

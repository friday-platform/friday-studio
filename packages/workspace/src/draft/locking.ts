/**
 * Draft Locking - Concurrent access control for workspace drafts
 */

import type { KVStorage } from "../../../../src/core/storage/index.ts";
import type { DraftLock, LockResult, WorkspaceDraft } from "../types.ts";

export class DraftLockManager {
  constructor(private storage: KVStorage) {}

  async acquireDraftLock(
    draftId: string,
    lockedBy: string,
    operation: string,
    timeoutMs: number = 5 * 60 * 1000,
  ): Promise<LockResult> {
    const lockKey = ["draft_locks", draftId];
    const now = new Date();
    const expiresAt = new Date(now.getTime() + timeoutMs);

    // Check if draft exists
    const draft = await this.storage.get<WorkspaceDraft>(["workspace_drafts", draftId]);
    if (!draft) {
      return {
        success: false,
        error: `Draft ${draftId} not found`,
      };
    }

    const lock: DraftLock = {
      draftId,
      lockedBy,
      lockedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      operation,
    };

    // Check existing lock
    const existingLock = await this.storage.get<DraftLock>(lockKey);

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

          await this.storage.set(lockKey, extendedLock);
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
    await this.storage.set(lockKey, lock);
    return {
      success: true,
      lock,
    };
  }

  async releaseDraftLock(draftId: string, lockedBy: string): Promise<boolean> {
    const lockKey = ["draft_locks", draftId];
    const lock = await this.storage.get<DraftLock>(lockKey);

    if (!lock) {
      return false; // No lock exists
    }

    if (lock.lockedBy !== lockedBy) {
      return false; // Lock owned by different holder
    }

    await this.storage.delete(lockKey);
    return true;
  }
}

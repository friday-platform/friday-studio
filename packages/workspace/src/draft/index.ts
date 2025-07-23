/**
 * Draft Management - Consolidated exports
 *
 * This module provides a clean API for all draft-related functionality:
 * - WorkspaceDraftStore for core CRUD operations
 * - DraftLockManager for concurrent access control
 * - DraftValidator for configuration validation
 * - Factory functions for easy instantiation
 */

// Core classes
export { WorkspaceDraftStore } from "./storage.ts";
export { DraftLockManager } from "./locking.ts";
export { DraftValidator } from "./validation.ts";

// Factory functions
export {
  createDraftStore,
  createDraftStoreFromStorage,
  createDraftStoreWithConfig,
} from "./factory.ts";

// Types are re-exported from the main types file
export type { DraftLock, LockResult, ValidationResult, WorkspaceDraft } from "../types.ts";

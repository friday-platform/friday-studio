/**
 * @atlas/workspace - Clean Workspace Management for Atlas
 *
 * This package provides workspace functionality following the Atlas patterns:
 * - WorkspaceManager for lifecycle management
 * - Draft functionality for iterative workspace development
 * - Clean type definitions and utilities
 *
 * @example
 * ```typescript
 * import { WorkspaceManager, WorkspaceDraftStore } from "@atlas/workspace";
 * import { WorkspaceEntry } from "@atlas/workspace/types";
 *
 * // Use workspace manager
 * const manager = await getWorkspaceManager();
 * const workspaces = await manager.list();
 *
 * // Use draft functionality
 * const draftStore = await createDraftStore();
 * const draft = await draftStore.createDraft({ ... });
 * ```
 */

// Export main components
export { getWorkspaceManager, WorkspaceManager } from "./src/manager.ts";
export {
  createDraftStore,
  createDraftStoreFromStorage,
  createDraftStoreWithConfig,
  DraftValidator,
  WorkspaceDraftStore,
} from "./src/draft/index.ts";

// Export all types and schemas
export type {
  DraftLock,
  LockResult,
  ValidationResult,
  WorkspaceDraft,
  WorkspaceEntry,
  WorkspaceMetadata,
  WorkspaceStatus,
} from "./src/types.ts";

export {
  WorkspaceEntrySchema,
  WorkspaceMetadataSchema,
  WorkspaceStatusEnum,
  WorkspaceStatusSchema,
} from "./src/types.ts";

// Export utilities
export {
  formatConfigForDisplay,
  hashConfig,
  isTestMode,
  mergeConfigs,
  validateWorkspace,
} from "./src/utils.ts";

// Export system workspaces
export { SYSTEM_WORKSPACES } from "@packages/system/workspaces";

// Export WorkspaceManagerOptions interface
export type { WorkspaceManagerOptions } from "./src/manager.ts";

/**
 * @atlas/workspace - Clean Workspace Management for Atlas
 *
 * This package provides workspace functionality following the Atlas patterns:
 * - WorkspaceManager for lifecycle management
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
 * ```
 */

// Export system workspaces
export { SYSTEM_WORKSPACES } from "@atlas/system/workspaces";
export type { RuntimeInvalidateCallback } from "./src/manager.ts";
// Export WorkspaceManagerOptions interface
// Export main components
export { getWorkspaceManager, WorkspaceManager } from "./src/manager.ts";
// Export all types and schemas
export type {
  WorkspaceEntry,
  WorkspaceMetadata,
  WorkspaceSignalRegistrar,
  WorkspaceStatus,
} from "./src/types.ts";
export {
  WorkspaceEntrySchema,
  WorkspaceMetadataSchema,
  WorkspaceStatusEnum,
  WorkspaceStatusSchema,
} from "./src/types.ts";
// Re-export watchers module for convenience
export * as watchers from "./src/watchers/index.ts";

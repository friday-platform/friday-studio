/**
 * @atlas/workspace - Clean Workspace Management for Atlas
 *
 * This package provides workspace functionality following the Atlas patterns:
 * - WorkspaceManager for lifecycle management
 * - Clean type definitions and utilities
 *
 * @example
 * ```typescript
 * import { WorkspaceManager, createRegistryStorageJS } from "@atlas/workspace";
 *
 * const registry = await createRegistryStorageJS(nc);
 * const manager = new WorkspaceManager(registry);
 * const workspaces = await manager.list();
 * ```
 */

// Export system workspaces
export { SYSTEM_WORKSPACES } from "@atlas/system/workspaces";
export type { CanonicalWorkspaceId, CanonicalWorkspaceKind } from "./src/canonical.ts";
// Canonical workspace helpers
export {
  CANONICAL_CONSTRAINTS,
  CANONICAL_WORKSPACE_IDS,
  getCanonicalKind,
  isCanonical,
  isCanonicalEntry,
} from "./src/canonical.ts";
export type { RuntimeInvalidateCallback } from "./src/manager.ts";
// Export WorkspaceManagerOptions interface
// Export main components
export { validateMCPEnvironmentForWorkspace, WorkspaceManager } from "./src/manager.ts";
// Runtime
export { classifySessionError, WorkspaceRuntime } from "./src/runtime.ts";
// Storage factories and registry adapter
export {
  createJetStreamKVStorage,
  createKVStorage,
  createRegistryStorageJS,
  createRegistryStorageMemory,
  RegistryStorageAdapter,
} from "./src/storage.ts";
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
export type { WorkspaceVariables } from "./src/variable-interpolation.ts";
// Variable interpolation ({{repo_root}}, {{platform_url}}, etc.)
export {
  findRepoRoot,
  interpolateConfig,
  resolveWorkspaceVariables,
  WorkspaceVariablesSchema,
} from "./src/variable-interpolation.ts";
// Re-export watchers module for convenience
export * as watchers from "./src/watchers/index.ts";

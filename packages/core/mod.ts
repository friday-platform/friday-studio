/**
 * @atlas/core - Core Atlas functionality
 *
 * This package provides the core workspace management functionality for Atlas.
 */

// Workspace Manager
export {
  getWorkspaceManager,
  WorkspaceManager,
  type WorkspaceManagerOptions,
} from "./src/workspace-manager.ts";

// Workspace Types
export {
  type WorkspaceEntry,
  WorkspaceEntrySchema,
  type WorkspaceMetadata,
  WorkspaceMetadataSchema,
  WorkspaceStatus,
  WorkspaceStatusSchema,
} from "./src/types/workspace.ts";

// Export all LLM provider types and interfaces
export type { LLMOptions, LLMResponse } from "./src/llm-provider.ts";
export { LLMProvider } from "./src/llm-provider.ts";
// Actor Types
export * from "./src/types/actors.ts";
export * from "./src/types/agent-execution.ts";
export * from "./src/types/xstate-events.ts";
export * from "./src/types/xstate-contexts.ts";

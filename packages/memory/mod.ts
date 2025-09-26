/**
 * Atlas Memory Package
 *
 * Session Bridge + Worklog Implementation for conversational continuity
 */

export type {
  CrossScopeMemorySync,
  MemoryConsolidationStrategy,
} from "./src/coala-consolidation.ts";
// Memory consolidation
export { WorkspaceMemoryConsolidator } from "./src/coala-consolidation.ts";
export type {
  CoALACognitiveLoop,
  CoALAMemoryEntry,
  CoALAMemoryQuery,
  IMemoryScope,
} from "./src/coala-memory.ts";
// Core memory manager and types
export {
  CoALAMemoryEntrySchema,
  CoALAMemoryManager,
  type CoALAMemoryType,
} from "./src/coala-memory.ts";
// === MECMF (Memory-Enhanced Context Management Framework) ===
// Global embedding provider for daemon initialization
export {
  embeddingProviderForceDispose,
  embeddingProviderGetInstance,
  embeddingProviderGetReferenceCount,
  embeddingProviderIsInitialized,
  embeddingProviderReleaseReference,
} from "./src/global-embedding-provider.ts";
// Main MECMF exports with factory functions
export * from "./src/mecmf.ts";
// Component-specific exports (also available through mecmf.ts)
// Export enum as a VALUE, not type-only, so it can be used at runtime
export type {
  ConversationContext,
  EnhancedPrompt,
  EnhancedVectorSearch,
  MECMFEmbeddingProvider,
  MECMFMemoryManager,
  MemoryClassifier,
  MemoryEntry,
  MemoryStatistics,
  MemoryType,
  RetrievalOptions,
  TokenBudgetManager,
} from "./src/mecmf-interfaces.ts";
export type { MECMFConfig } from "./src/mecmf-memory-manager.ts";
// Memory coordination for supervisors
export { SupervisorMemoryCoordinator } from "./src/supervisor-memory-coordinator.ts";
export { TaskCompletionDetector } from "./src/worklog/completion-detector.ts";
// Worklog System
export { WorklogManager } from "./src/worklog/worklog-manager.ts";
export {
  createSessionMemoryHooks,
  type SessionMemoryHooks,
  WorkspaceMemoryManager,
} from "./src/workspace-memory-integration.ts";

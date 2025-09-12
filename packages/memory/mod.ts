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
export { CoALAMemoryManager, CoALAMemoryType } from "./src/coala-memory.ts";
export { AsyncMemoryQueue } from "./src/streaming/async-memory-queue.ts";
export type {
  AgentResultStream,
  ContextualUpdateStream,
  EpisodicEventStream,
  MemoryStream,
  MemoryStreamProcessor,
  ProceduralPatternStream,
  SemanticFactStream,
  SessionCompleteStream,
  StreamingConfig,
} from "./src/streaming/memory-stream.ts";
export {
  AgentResultProcessor,
  EpisodicEventProcessor,
  ProceduralPatternProcessor,
  SemanticFactProcessor,
} from "./src/streaming/memory-stream-processors.ts";
export type { StreamingMemoryConfig } from "./src/streaming/streaming-memory-manager.ts";
// Streaming memory processing
export { StreamingMemoryManager } from "./src/streaming/streaming-memory-manager.ts";
// Memory coordination for supervisors
export { SupervisorMemoryCoordinator } from "./src/supervisor-memory-coordinator.ts";
export { TaskCompletionDetector } from "./src/worklog/completion-detector.ts";
// Worklog System
export { WorklogManager } from "./src/worklog/worklog-manager.ts";

// === MECMF (Memory-Enhanced Context Management Framework) ===

export type { MECMFDebugConfig, PromptEnhancementLog } from "./src/debug-logger.ts";
// Debug logging functionality
export {
  disableMECMFDebugLogging,
  enableMECMFDebugLogging,
  getGlobalMECMFDebugLogger,
  MECMFDebugLogger,
} from "./src/debug-logger.ts";
// Global embedding provider for daemon initialization
export { GlobalEmbeddingProvider } from "./src/global-embedding-provider.ts";
// Main MECMF exports with factory functions
export * from "./src/mecmf.ts";
// Component-specific exports (also available through mecmf.ts)
export type {
  ConversationContext,
  EnhancedPrompt,
  EnhancedVectorSearch,
  MECMFEmbeddingProvider,
  MECMFMemoryManager,
  MemoryClassifier,
  MemoryEntry,
  MemoryStatistics,
  RetrievalOptions,
  TokenBudgetManager,
} from "./src/mecmf-interfaces.ts";
// Export enum as a VALUE, not type-only, so it can be used at runtime
export { MemoryType } from "./src/mecmf-interfaces.ts";
export type { MECMFConfig } from "./src/mecmf-memory-manager.ts";
export {
  createSessionMemoryHooks,
  type SessionMemoryHooks,
  WorkspaceMemoryManager,
} from "./src/workspace-memory-integration.ts";

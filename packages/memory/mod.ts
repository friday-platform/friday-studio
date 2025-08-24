/**
 * @atlas/memory - Memory Management Package
 *
 * This package provides comprehensive memory management for Atlas, including:
 *
 * ## CoALA Memory System:
 * - Multi-layered memory hierarchies (working, episodic, semantic, procedural)
 * - Adaptive retrieval based on context and relevance
 * - Cross-agent memory sharing and reflection
 * - Cognitive loops for memory consolidation and adaptation
 * - Streaming memory processing for real-time updates
 *
 * ## MECMF (Memory-Enhanced Context Management Framework):
 * - Token-aware prompt construction and budget management
 * - WebAssembly-based local embeddings with sentence-transformers
 * - Intelligent memory classification and entity extraction
 * - Vector similarity search with <100ms retrieval targets
 * - Graceful degradation and comprehensive error handling
 * - Production-ready performance optimizations
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
export type {
  ExtractedFact,
  IKnowledgeGraphStorageAdapter,
  KnowledgeEntity,
  KnowledgeFact,
  KnowledgeGraphQuery,
  KnowledgeRelationship,
} from "./src/knowledge-graph.ts";
// Knowledge graph functionality
export {
  KnowledgeEntityType,
  KnowledgeGraphManager,
  KnowledgeRelationType,
} from "./src/knowledge-graph.ts";

// Fact extraction capabilities moved to packages/system/agents/fact-extractor.ts
// to avoid circular dependency with BaseAgent

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

// === MECMF (Memory-Enhanced Context Management Framework) ===

export type { MECMFDebugConfig, PromptEnhancementLog } from "./src/debug-logger.ts";
// Debug logging functionality
export {
  disableMECMFDebugLogging,
  enableMECMFDebugLogging,
  getGlobalMECMFDebugLogger,
  MECMFDebugLogger,
} from "./src/debug-logger.ts";
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

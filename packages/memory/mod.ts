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

// Core memory manager and types
export { CoALAMemoryManager, CoALAMemoryType } from "./src/coala-memory.ts";
export type {
  CoALACognitiveLoop,
  CoALAMemoryEntry,
  CoALAMemoryQuery,
  IMemoryScope,
} from "./src/coala-memory.ts";

// Knowledge graph functionality
export { KnowledgeGraphManager } from "./src/knowledge-graph.ts";
export type { ExtractedFact, KnowledgeGraphQuery } from "./src/knowledge-graph.ts";
export { KnowledgeEntityType, KnowledgeRelationType } from "./src/knowledge-graph.ts";
export type {
  IKnowledgeGraphStorageAdapter,
  KnowledgeEntity,
  KnowledgeFact,
  KnowledgeRelationship,
} from "./src/knowledge-graph.ts";

// Memory consolidation
export { WorkspaceMemoryConsolidator } from "./src/coala-consolidation.ts";
export type {
  CrossScopeMemorySync,
  MemoryConsolidationStrategy,
} from "./src/coala-consolidation.ts";

// Fact extraction capabilities moved to packages/system/agents/fact-extractor.ts
// to avoid circular dependency with BaseAgent

// Memory coordination for supervisors
export { SupervisorMemoryCoordinator } from "./src/supervisor-memory-coordinator.ts";

// Streaming memory processing
export { StreamingMemoryManager } from "./src/streaming/streaming-memory-manager.ts";
export type { StreamingMemoryConfig } from "./src/streaming/streaming-memory-manager.ts";

export { AsyncMemoryQueue } from "./src/streaming/async-memory-queue.ts";

export {
  AgentResultProcessor,
  EpisodicEventProcessor,
  ProceduralPatternProcessor,
  SemanticFactProcessor,
} from "./src/streaming/memory-stream-processors.ts";

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

// === MECMF (Memory-Enhanced Context Management Framework) ===

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
  MemoryType,
  RetrievalOptions,
  TokenBudgetManager,
} from "./src/mecmf-interfaces.ts";

export type { MECMFConfig } from "./src/mecmf-memory-manager.ts";

// Debug logging functionality
export {
  disableMECMFDebugLogging,
  enableMECMFDebugLogging,
  getGlobalMECMFDebugLogger,
  MECMFDebugLogger,
} from "./src/debug-logger.ts";
export type { MECMFDebugConfig, PromptEnhancementLog } from "./src/debug-logger.ts";

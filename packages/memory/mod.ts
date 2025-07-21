/**
 * @atlas/memory - CoALA Memory Management Package
 *
 * This package provides the CoALA (Cognitive Architectures as Language Agents)
 * memory implementation for Atlas, including:
 * - Multi-layered memory hierarchies (working, episodic, semantic, procedural)
 * - Adaptive retrieval based on context and relevance
 * - Cross-agent memory sharing and reflection
 * - Cognitive loops for memory consolidation and adaptation
 * - Streaming memory processing for real-time updates
 */

// Core memory manager and types
export { CoALAMemoryManager, CoALAMemoryType } from "./src/coala-memory.ts";
export type { CoALACognitiveLoop, CoALAMemoryEntry, CoALAMemoryQuery } from "./src/coala-memory.ts";

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

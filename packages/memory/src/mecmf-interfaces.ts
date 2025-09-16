/**
 * Memory-Enhanced Context Management Framework (MECMF) Core Interfaces
 *
 * These interfaces implement the TypeScript specifications from MECMF Section 2.5
 * providing the foundation for intelligent memory management and token-aware operations.
 */

export interface ConversationContext {
  sessionId: string;
  workspaceId: string;
  currentTask?: string;
  recentMessages: string[];
  activeAgents: string[];
}

// Minimal identity for memory scoping used by MECMF/CoALA
export interface MemoryScope {
  id: string;
  workspaceId?: string;
}

export enum MemorySource {
  USER_INPUT = "user_input",
  AGENT_OUTPUT = "agent_output",
  TOOL_OUTPUT = "tool_output",
  SYSTEM_GENERATED = "system_generated",
}

export interface MemorySourceMetadata {
  agentId?: string;
  toolName?: string;
  sessionId?: string;
  userId?: string;
  workspaceId?: string;
}

export interface Entity {
  name: string;
  type: string;
  confidence: number;
  attributes?: Record<string, string>;
}

export interface MemoryEntry {
  id: string;
  content: string | Record<string, string>;
  timestamp: Date;
  memoryType: MemoryType;
  relevanceScore: number;
  sourceScope: string;
  tags: string[];
  confidence: number;
  decayRate: number;
  embedding?: number[];
  source: MemorySource;
  sourceMetadata?: MemorySourceMetadata;
}

export enum MemoryType {
  WORKING = "working",
  SESSION_BRIDGE = "session_bridge",
  EPISODIC = "episodic",
  SEMANTIC = "semantic",
  PROCEDURAL = "procedural",
}

export interface VectorEmbedding {
  vector: number[];
  dimension: number;
  model: string;
}

export interface Memory {
  id: string;
  content: string;
  type: MemoryType;
  tokens: number;
  relevanceScore: number;
  timestamp: Date;
}

// === MECMF Section 2.5.1: Memory Classification System ===

export interface MemoryClassifier {
  classifyContent(content: string, context: ConversationContext): MemoryType;
  extractKeyEntities(content: string, source?: MemorySource): Entity[];
  calculateRelevanceScore(memory: MemoryEntry, query: string): number;
}

export interface ClassificationRules {
  working_memory: {
    contains_session_context: boolean;
    temporal_relevance: "immediate" | "short_term";
    lifespan: "session_scoped";
  };
  episodic_memory: {
    contains_outcomes: boolean;
    temporal_markers: boolean;
    experience_indicators: ["success", "failure", "learning"];
  };
  semantic_memory: {
    factual_content: boolean;
    knowledge_structures: boolean;
    cross_session_relevance: boolean;
  };
}

// === MECMF Section 2.5.2: Token Budget Management ===

export interface TokenBudgetManager {
  calculateAvailableTokens(modelLimits: number, reservedTokens: number): number;
  allocateTokensByType(budget: number): TokenAllocation;
  optimizeContentForBudget(content: Memory[], budget: number): Memory[];
}

export interface TokenAllocation {
  working_memory: number; // 40% of budget
  procedural_memory: number; // 25% of budget
  semantic_memory: number; // 25% of budget
  episodic_memory: number; // 10% of budget
}

// === MECMF Section 2.5.3: Vector Search Integration ===

export interface EnhancedVectorSearch {
  generateEmbedding(text: string): Promise<VectorEmbedding>;
  findSimilarMemories(query: VectorEmbedding, threshold: number): Promise<MemoryEntry[]>;
  hybridSearch(textQuery: string, vectorQuery: VectorEmbedding): Promise<MemoryEntry[]>;
}

export interface AtlasEmbeddingConfig {
  model: "sentence-transformers/all-MiniLM-L6-v2"; // Production model from /embeddings/
  backend: "onnxruntime-node" | "wasm";
  batchSize: number;
  maxSequenceLength: number; // BERT tokenizer max length (512)
  cacheDirectory: string; // Model caching directory
  tokenizerConfig: {
    doLowerCase: boolean;
    maxLength: number;
    padTokenId: number;
    unkTokenId: number;
    clsTokenId: number;
    sepTokenId: number;
  };
}

export interface PerformanceExpectations {
  memory_retrieval_latency: "<100ms for vector search";
  embedding_generation: "~30ms per query via ONNX Runtime"; // Based on /embeddings/ benchmarks
  model_loading: "~50ms cached, 2-3s cold start";
  memory_consolidation: "<5 seconds for batch operations";
  storage_growth_rate: "<100MB per 1000 conversations + 200MB model cache";
  cross_platform_consistency: "100% identical results via WebAssembly backend";
  tokenization_speed: "<5ms per text with BERT tokenizer";
}

// === MECMF Section 3.4: Error Handling and Fallback Strategies ===

export interface FailureRecoveryStrategies {
  embedding_service_down: {
    fallback: "text-based keyword search";
    timeout: "5 seconds";
    retry_attempts: 3;
  };
  storage_capacity_exceeded: {
    action: "emergency_pruning_with_backup";
    threshold: "90% capacity";
    recovery_target: "70% capacity";
  };
  vector_search_timeout: {
    fallback: "cached_recent_memories";
    timeout_threshold: "500ms";
    cache_size: 50;
  };
  memory_corruption: {
    recovery: "restore_from_checkpoint";
    checkpoint_interval: "1 hour";
    validation_checks: true;
  };
}

export interface ResourceManagement {
  memory_pressure: {
    trigger_threshold: "85% of available memory";
    response: "immediate_pruning_of_low_relevance_memories";
    emergency_threshold: "95% of available memory";
    emergency_response: "clear_working_memory_and_alert";
  };
  disk_space_pressure: {
    trigger_threshold: "90% of allocated storage";
    response: "compress_old_memories_and_archive";
    emergency_threshold: "98% of allocated storage";
    emergency_response: "emergency_pruning_with_backup";
  };
}

// === MECMF Embedding Provider Interface ===

export interface MECMFEmbeddingProvider {
  generateEmbedding(text: string): Promise<number[]>;
  generateEmbeddingBatch(texts: string[]): Promise<number[][]>;
  getDimension(): number;
  getModelInfo(): string;
  isReady(): boolean;
  warmup(): Promise<void>;
  dispose(): Promise<void>;
}

// === MECMF Memory Manager Interface ===

export interface MECMFMemoryManager {
  // Lifecycle management
  initialize(): Promise<void>;
  dispose(): Promise<void>;

  // Core memory operations
  storeMemory(entry: MemoryEntry): Promise<void>;
  retrieveMemory(id: string): Promise<MemoryEntry | null>;
  deleteMemory(id: string): Promise<void>;

  // Classification and management
  classifyAndStore(
    content: string,
    context: ConversationContext,
    source?: MemorySource,
    sourceMetadata?: MemorySourceMetadata,
  ): Promise<string>;
  getRelevantMemories(query: string, options?: RetrievalOptions): Promise<MemoryEntry[]>;

  // Token-aware operations
  buildTokenAwarePrompt(originalPrompt: string, tokenBudget: number): Promise<EnhancedPrompt>;
  optimizeMemoryForTokens(memories: MemoryEntry[], budget: number): MemoryEntry[];

  // Enhanced prompt construction with memory context
  enhancePromptWithMemory(
    originalPrompt: string,
    options?: {
      tokenBudget?: number;
      contextFormat?: "detailed" | "summary" | "bullets";
      includeTypes?: MemoryType[];
      maxMemories?: number;
    },
  ): Promise<EnhancedPrompt>;

  // Memory consolidation and pruning
  consolidateWorkingMemory(): Promise<void>;
  pruneByRelevance(threshold: number): Promise<number>;
  getMemoryStatistics(): MemoryStatistics;
}

export interface RetrievalOptions {
  memoryTypes?: MemoryType[];
  maxResults?: number;
  minRelevanceScore?: number;
  maxAge?: number; // milliseconds
  includeSimilarity?: boolean;
}

export interface EnhancedPrompt {
  enhancedPrompt: string;
  originalPrompt: string;
  memoryContext: string;
  tokensUsed: number;
  memoriesIncluded: number;
  memoryBreakdown: Record<MemoryType, number>;
}

export interface MemoryStatistics {
  totalMemories: number;
  byType: Record<MemoryType, number>;
  averageRelevance: number;
  oldestEntry: Date | null;
  newestEntry: Date | null;
  totalSize: number; // estimated bytes
}

// === Session Bridge Memory Interfaces ===

export interface SessionBridgeConfig {
  max_turns: number; // Default: 10
  retention_hours: number; // Default: 48
  token_allocation: number; // Default: 0.10 (10% of working memory)
  relevance_threshold: number; // Default: 0.6
}

// === Worklog System Interfaces ===

export interface CompletionPattern {
  type: "task_completed" | "decision_made" | "file_modified" | "command_executed";
  patterns: string[];
  extractionRule: string; // Function name reference
}

export interface WorklogEntry {
  id: string;
  timestamp: Date;
  session_id: string;
  type: "task_completed" | "decision_made" | "file_modified" | "command_executed";
  title: string; // Brief description
  description: string; // 1-2 sentence context
  outcome: "success" | "failure" | "partial";
  files_affected?: string[];
  commands_used?: string[];
  next_actions?: string[];
  tags: string[];
  confidence: number; // 0-1, extraction confidence
}

export interface WorklogMemoryEntry extends MemoryEntry {
  memoryType: MemoryType.EPISODIC;
  subtype: "worklog";
  worklog_data: WorklogEntry;
}

// === Enhanced Token Management Interfaces ===

export interface ExtendedTokenAllocation {
  working_memory: number; // 35% (reduced from 40%)
  session_bridge: number; // 10% (new allocation)
  procedural_memory: number; // 25%
  semantic_memory: number; // 20% (reduced from 25%)
  episodic_memory: number; // 10%
  worklog_context: number; // 5% (subset of episodic)
}

// === Memory Configuration Schema ===

export interface MemoryConfiguration {
  session_bridge: {
    enabled: boolean;
    max_turns: number;
    retention_hours: number;
    token_allocation: number;
    relevance_threshold: number;
  };
  worklog: {
    enabled: boolean;
    auto_detect: boolean;
    confidence_threshold: number;
    max_entries_per_session: number;
    retention_days: number;
  };
  token_management: {
    bridge_allocation: number;
    worklog_allocation: number;
    compression_threshold: number;
  };
}

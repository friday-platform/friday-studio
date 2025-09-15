/**
 * CoALA (Cognitive Architectures as Language Agents) Memory Implementation for Atlas
 *
 * This implementation provides cognitive memory systems with:
 * - Multi-layered memory hierarchies (working, episodic, semantic, procedural)
 * - Adaptive retrieval based on context and relevance
 * - Cross-agent memory sharing and reflection
 * - Cognitive loops for memory consolidation and adaptation
 */

import { logger } from "@atlas/logger";
import {
  CoALALocalFileStorageAdapter,
  type IVectorSearchStorageAdapter,
  type VectorEmbedding,
  type VectorSearchConfig,
  VectorSearchLocalStorageAdapter,
  type VectorSearchQuery,
} from "@atlas/storage";
import { z } from "zod";
import type {
  IAtlasScope,
  ICoALAMemoryStorageAdapter,
  ITempestMemoryManager,
} from "../../../src/types/core.ts";
import { getWorkspaceMemoryDir, getWorkspaceVectorDir } from "../../../src/utils/paths.ts";
import { type ProcessedPrompt, tokenizePrompt } from "../../../src/utils/prompt-tokenizer.ts";
import { GlobalEmbeddingProvider } from "./global-embedding-provider.ts";
import type { MECMFEmbeddingProvider } from "./mecmf-interfaces.ts";

// Define the enum first
export enum CoALAMemoryType {
  WORKING = "working", // Short-term, active processing
  EPISODIC = "episodic", // Specific experiences and events
  SEMANTIC = "semantic", // General knowledge and concepts
  PROCEDURAL = "procedural", // How-to knowledge and skills
  CONTEXTUAL = "contextual", // Session/agent specific context
}

// Zod schemas for type-safe memory operations
const CoALAMemoryTypeSchema = z.nativeEnum(CoALAMemoryType);

const CoALASourceMetadataSchema = z
  .object({
    agentId: z.string().optional(),
    toolName: z.string().optional(),
    sessionId: z.string().optional(),
    userId: z.string().optional(),
    workspaceId: z.string().optional(),
  })
  .optional();

const CoALAMemoryEntrySchema = z.object({
  id: z.string(),
  content: z.union([z.string(), z.record(z.string(), z.string())]),
  timestamp: z.coerce.date(),
  accessCount: z.number(),
  lastAccessed: z.coerce.date(),
  memoryType: CoALAMemoryTypeSchema,
  relevanceScore: z.number(),
  sourceScope: z.string(),
  associations: z.array(z.string()),
  tags: z.array(z.string()),
  confidence: z.number(),
  decayRate: z.number(),
  source: z.string().optional(),
  sourceMetadata: CoALASourceMetadataSchema,
});

export type CoALAMemoryEntry = z.infer<typeof CoALAMemoryEntrySchema>;

export interface CoALACognitiveLoop {
  reflect(): CoALAMemoryEntry[];
  consolidate(): void;
  prune(): void;
  adapt(feedback: unknown): void;
}

export interface CoALAMemoryQuery {
  content?: string;
  memoryType?: CoALAMemoryType;
  tags?: string[];
  minRelevance?: number;
  maxAge?: number; // milliseconds
  sourceScope?: string;
  limit?: number;
}

// Minimal interface for what CoALAMemoryManager actually needs
export interface IMemoryScope {
  id: string;
  workspaceId?: string;
}

export class CoALAMemoryManager implements ITempestMemoryManager, CoALACognitiveLoop {
  private store: ICoALAMemoryStorageAdapter;
  private memories: Map<string, CoALAMemoryEntry> = new Map();
  private memoriesByType: Map<CoALAMemoryType, Map<string, CoALAMemoryEntry>> = new Map();
  private scope: IMemoryScope;
  private cognitiveLoopInterval: number = 300000; // 5 minutes
  private loopTimer?: number;
  // private knowledgeGraph?: KnowledgeGraphManager;
  private vectorSearch?: IVectorSearchStorageAdapter;
  private embeddingProvider?: MECMFEmbeddingProvider;
  private vectorSearchConfig: VectorSearchConfig | null = null;
  private vectorIndexedTypes = new Set<CoALAMemoryType>([
    CoALAMemoryType.EPISODIC,
    CoALAMemoryType.SEMANTIC,
    CoALAMemoryType.PROCEDURAL,
  ]);
  private commitDebounceTimer?: number;
  private commitDebounceDelay = 500; // 500ms debounce
  private pendingCommit = false;
  // Working memory helpers
  private workingKeyCounters: Map<string, number> = new Map();

  private isLoaded = false;
  private loadingPromise?: Promise<void>;

  constructor(
    scope: IMemoryScope | IAtlasScope,
    storageAdapter?: ICoALAMemoryStorageAdapter,
    enableCognitiveLoop: boolean = true,
    options?: { vectorSearchConfig?: Partial<VectorSearchConfig>; commitDebounceDelay?: number },
  ) {
    this.scope = scope;

    // Allow override of debounce delay (e.g., set to 0 for tests)
    if (options?.commitDebounceDelay !== undefined) {
      this.commitDebounceDelay = options.commitDebounceDelay;
    }

    // Use CoALA storage adapter if provided, otherwise create workspace-specific one
    if (storageAdapter && "commitByType" in storageAdapter) {
      this.store = storageAdapter;
    } else if (storageAdapter) {
      // Wrap legacy adapter for backwards compatibility
      const workspaceId = scope.workspaceId || scope.id;
      this.store = new CoALALocalFileStorageAdapter(getWorkspaceMemoryDir(workspaceId));
    } else {
      // Create new workspace-specific storage adapter
      const workspaceId = scope.workspaceId || scope.id;
      this.store = new CoALALocalFileStorageAdapter(getWorkspaceMemoryDir(workspaceId));
    }

    // Initialize memory type maps
    Object.values(CoALAMemoryType).forEach((type) => {
      this.memoriesByType.set(type, new Map());
    });

    // In test environments, skip all background operations and timers
    const isTestEnvironment = Deno.env.get("DENO_TESTING") === "true";

    if (!isTestEnvironment) {
      // Initialize knowledge graph for semantic memory enhancement
      this.initializeKnowledgeGraph();

      // Only load from storage if not using in-memory adapter
      if (this.store.constructor.name !== "InMemoryStorageAdapter") {
        // Start loading asynchronously but make it available for awaiting
        this.loadingPromise = this.loadFromStorage().then(async () => {
          this.isLoaded = true;
          // Initialize vector search after loading is complete
          await this.initializeVectorSearch(options?.vectorSearchConfig);
        });
      } else {
        this.isLoaded = true;
      }

      if (enableCognitiveLoop) {
        this.startCognitiveLoop();
      }
    } else {
      this.isLoaded = true;
    }
  }

  recall(key: string): unknown {
    const memory = this.memories.get(key);
    if (memory) {
      // Update access patterns for adaptive retrieval
      memory.accessCount++;
      memory.lastAccessed = new Date();
      memory.relevanceScore = this.calculateRelevanceScore(memory);
      return memory.content;
    }
    return undefined;
  }

  // Enhanced CoALA memory methods
  rememberWithMetadata(
    key: string,
    content: string | Record<string, string>,
    metadata: {
      memoryType: CoALAMemoryType;
      tags: string[];
      relevanceScore: number;
      associations?: string[];
      confidence?: number;
      decayRate?: number;
      source?: string;
      sourceMetadata?: {
        agentId?: string;
        toolName?: string;
        sessionId?: string;
        userId?: string;
        workspaceId?: string;
      };
    },
  ): void {
    const memory: CoALAMemoryEntry = {
      id: key,
      content,
      timestamp: new Date(),
      accessCount: 0,
      lastAccessed: new Date(),
      memoryType: metadata.memoryType,
      relevanceScore: metadata.relevanceScore,
      sourceScope: this.scope.workspaceId || this.scope.id,
      associations: metadata.associations || [],
      tags: metadata.tags,
      confidence: metadata.confidence || 1.0,
      decayRate: metadata.decayRate || 0.1,
      source: metadata.source || "system_generated",
      sourceMetadata: metadata.sourceMetadata,
    };

    // Store in both global and type-specific maps
    this.memories.set(key, memory);
    const typeMap = this.memoriesByType.get(metadata.memoryType);
    if (typeMap) {
      typeMap.set(key, memory);
    }

    this.updateAssociations(memory);

    // Index in vector search if enabled and memory type is indexed
    if (this.vectorSearch && this.vectorIndexedTypes.has(metadata.memoryType)) {
      this.indexMemoryInVectorSearch(memory).catch((error) => {
        logger.warn(`Failed to index memory ${key} in vector search`, { error, key });
      });
    }

    // TODO: it looks like need some async handling here
    this.debouncedCommitToStorage();
  }

  /**
   * Generate a stable, incrementing key for WORKING memory entries scoped by session
   * Format: wrk:{sessionId}:{n}
   */
  generateWorkingKey(sessionId: string): string {
    const current = this.workingKeyCounters.get(sessionId) || 0;
    const next = current + 1;
    this.workingKeyCounters.set(sessionId, next);
    return `wrk:${sessionId}:${next}`;
  }

  /**
   * Store a single WORKING memory entry with automatic keying
   */
  rememberWorking(
    sessionId: string,
    content: string | Record<string, string>,
    options?: { tags?: string[]; relevanceScore?: number; confidence?: number; decayRate?: number },
  ): string {
    const key = this.generateWorkingKey(sessionId);
    this.rememberWithMetadata(key, content, {
      memoryType: CoALAMemoryType.WORKING,
      tags: ["working", "session", ...(options?.tags || [])],
      relevanceScore: options?.relevanceScore ?? 0.6,
      confidence: options?.confidence ?? 0.9,
      decayRate: options?.decayRate ?? 0.5,
    });
    return key;
  }

  /**
   * Clear all WORKING memory entries that belong to a given session
   */
  clearWorkingBySession(sessionId: string): number {
    const typeMap = this.memoriesByType.get(CoALAMemoryType.WORKING);
    if (!typeMap) return 0;

    let deletedCount = 0;
    for (const [key, _] of typeMap.entries()) {
      this.memories.delete(key);
      typeMap.delete(key);
      deletedCount++;
    }

    // Reset session counter to 0 so keys start fresh on next run
    this.workingKeyCounters.delete(sessionId);

    // Commit changes
    if (deletedCount > 0) {
      this.debouncedCommitToStorage();
    }

    return deletedCount;
  }

  /**
   * Ensure memories are loaded before querying
   */
  async ensureLoaded(): Promise<void> {
    if (!this.isLoaded && this.loadingPromise) {
      await this.loadingPromise;
    }
  }

  queryMemories(query: CoALAMemoryQuery): CoALAMemoryEntry[] {
    let results = Array.from(this.memories.values());

    // Apply filters
    if (query.memoryType) {
      results = results.filter((m) => m.memoryType === query.memoryType);
    }

    if (query.tags && query.tags.length > 0) {
      results = results.filter((m) => query.tags!.some((tag) => m.tags.includes(tag)));
    }

    if (query.minRelevance) {
      results = results.filter((m) => m.relevanceScore >= query.minRelevance!);
    }

    if (query.maxAge) {
      const cutoff = new Date(Date.now() - query.maxAge);
      results = results.filter((m) => m.timestamp >= cutoff);
    }

    if (query.sourceScope) {
      results = results.filter((m) => m.sourceScope === query.sourceScope);
    }

    // Content-based search
    if (query.content) {
      results = results.filter((m) =>
        JSON.stringify(m.content).toLowerCase().includes(query.content!.toLowerCase()),
      );
    }

    // Sort by relevance and recency
    results.sort((a, b) => {
      const relevanceDiff = b.relevanceScore - a.relevanceScore;
      if (Math.abs(relevanceDiff) > 0.1) return relevanceDiff;
      return b.timestamp.getTime() - a.timestamp.getTime();
    });

    return query.limit ? results.slice(0, query.limit) : results;
  }

  // Cognitive Loop Implementation
  reflect(): CoALAMemoryEntry[] {
    // Identify memories that need attention
    const candidatesForReflection = Array.from(this.memories.values()).filter((memory) => {
      const age = Date.now() - memory.timestamp.getTime();
      const timeSinceAccess = Date.now() - memory.lastAccessed.getTime();

      // Reflect on frequently accessed memories or old un-accessed ones
      return (
        (memory.accessCount > 5 && age > 3600000) || // 1 hour old, frequently accessed
        timeSinceAccess > 86400000
      ); // 24 hours since last access
    });

    // Update relevance scores based on reflection
    for (const memory of candidatesForReflection) {
      memory.relevanceScore = this.calculateRelevanceScore(memory);
    }

    return candidatesForReflection;
  }

  consolidate(): void {
    // Move working memories to long-term storage based on patterns
    const workingMemories = this.queryMemories({
      memoryType: CoALAMemoryType.WORKING,
      minRelevance: 0.7,
    });

    for (const memory of workingMemories) {
      if (memory.accessCount > 3 || memory.relevanceScore > 0.8) {
        // Promote to episodic or semantic memory
        memory.memoryType = this.determineMemoryType(memory);
        memory.relevanceScore *= 1.1; // Boost consolidated memories
      }
    }

    this.debouncedCommitToStorage();
  }

  prune(): void {
    // Remove low-relevance, old memories to maintain performance
    const memoriesToPrune = Array.from(this.memories.values()).filter((memory) => {
      const age = Date.now() - memory.timestamp.getTime();
      const decayedRelevance =
        memory.relevanceScore * Math.exp((-memory.decayRate * age) / 86400000); // Daily decay

      return decayedRelevance < 0.1 && age > 604800000; // 1 week old, very low relevance
    });

    for (const memory of memoriesToPrune) {
      // Remove from both global and type-specific maps
      this.memories.delete(memory.id);
      const typeMap = this.memoriesByType.get(memory.memoryType);
      if (typeMap) {
        typeMap.delete(memory.id);
      }

      // Remove from vector index if applicable
      if (this.vectorSearch && this.vectorIndexedTypes.has(memory.memoryType)) {
        const vectorId = `${memory.memoryType}_${memory.id}`;
        this.vectorSearch.deleteEmbeddings([vectorId]).catch((error) => {
          logger.warn(`Failed to remove pruned memory ${memory.id} from vector search`, {
            error,
            memoryId: memory.id,
          });
        });
      }
    }

    this.debouncedCommitToStorage();
  }

  adapt(feedback: { memoryId: string; relevanceAdjustment: number }): void {
    const memory = this.memories.get(feedback.memoryId);
    if (memory) {
      memory.relevanceScore = Math.max(
        0,
        Math.min(1, memory.relevanceScore + feedback.relevanceAdjustment),
      );
      memory.confidence = Math.max(
        0,
        Math.min(1, memory.confidence + feedback.relevanceAdjustment * 0.1),
      );
    }
  }

  // Cross-agent memory sharing
  shareMemoryWithScope(targetScopeId: string, memoryIds: string[]): void {
    // Implementation would depend on inter-scope communication mechanism
    // For now, we'll mark memories as shareable
    for (const memoryId of memoryIds) {
      const memory = this.memories.get(memoryId);
      if (memory) {
        memory.tags.push(`shared:${targetScopeId}`);
      }
    }
  }

  // Legacy compatibility methods
  summarize(): string {
    const memoryStats = this.getMemoryStatistics();
    return `CoALA Memory Summary:
Working: ${memoryStats.working} memories
Episodic: ${memoryStats.episodic} memories
Semantic: ${memoryStats.semantic} memories
Procedural: ${memoryStats.procedural} memories
Total: ${this.memories.size} memories
Avg Relevance: ${memoryStats.avgRelevance.toFixed(2)}`;
  }

  size(): number {
    return this.memories.size;
  }

  getMemoryById(id: string): CoALAMemoryEntry | undefined {
    return this.memories.get(id);
  }

  forget(key: string): void {
    const memory = this.memories.get(key);
    if (memory) {
      // Remove from both global and type-specific maps
      this.memories.delete(key);
      const typeMap = this.memoriesByType.get(memory.memoryType);
      if (typeMap) {
        typeMap.delete(key);
      }

      // Remove from vector index if applicable
      if (this.vectorSearch && this.vectorIndexedTypes.has(memory.memoryType)) {
        const vectorId = `${memory.memoryType}_${memory.id}`;
        this.vectorSearch.deleteEmbeddings([vectorId]).catch((error) => {
          logger.warn(`Failed to remove memory ${key} from vector search`, { error, key });
        });
      }
    }
    this.debouncedCommitToStorage();
  }

  // Private helper methods
  private calculateRelevanceScore(memory: CoALAMemoryEntry): number {
    const age = Date.now() - memory.timestamp.getTime();
    const timeSinceAccess = Date.now() - memory.lastAccessed.getTime();

    // Base relevance on access patterns and recency
    const accessScore = Math.min(1, memory.accessCount / 10);
    const recencyScore = Math.exp(-age / 86400000); // Exponential decay over days
    const freshAccessScore = Math.exp(-timeSinceAccess / 3600000); // Recent access bonus

    return (accessScore * 0.4 + recencyScore * 0.3 + freshAccessScore * 0.3) * memory.confidence;
  }

  private determineMemoryType(memory: CoALAMemoryEntry): CoALAMemoryType {
    // Simple heuristics for memory type classification
    if (memory.tags.includes("procedure") || memory.tags.includes("how-to")) {
      return CoALAMemoryType.PROCEDURAL;
    }
    if (memory.tags.includes("fact") || memory.tags.includes("knowledge")) {
      return CoALAMemoryType.SEMANTIC;
    }
    return CoALAMemoryType.EPISODIC; // Default for experiences
  }

  private updateAssociations(memory: CoALAMemoryEntry): void {
    // Find related memories based on tags and content similarity
    const relatedMemories = Array.from(this.memories.values())
      .filter((m) => m.id !== memory.id)
      .filter((m) => {
        const sharedTags = m.tags.filter((tag) => memory.tags.includes(tag));
        return sharedTags.length > 0;
      })
      .slice(0, 5); // Limit associations

    memory.associations = relatedMemories.map((m) => m.id);

    // Update reverse associations
    for (const related of relatedMemories) {
      if (!related.associations.includes(memory.id)) {
        related.associations.push(memory.id);
      }
    }
  }

  private getMemoryStatistics() {
    const stats = {
      working: 0,
      episodic: 0,
      semantic: 0,
      procedural: 0,
      contextual: 0,
      avgRelevance: 0,
    };

    let totalRelevance = 0;
    for (const memory of this.memories.values()) {
      stats[memory.memoryType]++;
      totalRelevance += memory.relevanceScore;
    }

    stats.avgRelevance = this.memories.size > 0 ? totalRelevance / this.memories.size : 0;
    return stats;
  }

  private startCognitiveLoop(): void {
    this.loopTimer = setInterval(() => {
      try {
        this.reflect();
        this.consolidate();
        this.prune();
      } catch (error) {
        logger.warn("CoALA cognitive loop error", { error });
      }
    }, this.cognitiveLoopInterval);
  }

  private debouncedCommitToStorage(): void {
    // If delay is 0, commit immediately (useful for tests)
    if (this.commitDebounceDelay === 0) {
      this.commitToStorage().catch((error) => {
        logger.error("Failed to commit memory to storage", { error });
      });
      return;
    }

    // Mark that we have a pending commit
    this.pendingCommit = true;

    // Clear any existing timer
    if (this.commitDebounceTimer) {
      clearTimeout(this.commitDebounceTimer);
    }

    // Set a new timer to commit after the delay
    this.commitDebounceTimer = setTimeout(() => {
      if (this.pendingCommit) {
        this.commitToStorage().catch((error) => {
          logger.error("Failed to commit memory to storage", { error });
        });
      }
    }, this.commitDebounceDelay);
  }

  async commitToStorage(): Promise<void> {
    // Clear the pending flag
    this.pendingCommit = false;
    // Organize memories by type for multi-file storage
    const dataByType: Record<string, unknown> = {};

    for (const [memoryType, typeMap] of this.memoriesByType.entries()) {
      if (typeMap.size > 0) {
        const serializedTypeMemories = Object.fromEntries(
          Array.from(typeMap.entries()).map(([key, memory]) => {
            // Validate memory entry before serialization
            const parseResult = CoALAMemoryEntrySchema.safeParse(memory);
            if (!parseResult.success) {
              logger.warn(`Invalid memory entry during commit: ${key}`, {
                error: parseResult.error,
                memoryType,
              });
              // Use original memory for backward compatibility but log the issue
            }

            return [
              key,
              {
                ...memory,
                timestamp: memory.timestamp.toISOString(),
                lastAccessed: memory.lastAccessed.toISOString(),
              },
            ];
          }),
        );
        dataByType[memoryType] = serializedTypeMemories;
      }
    }

    // Use type-specific storage if available
    if ("commitAll" in this.store && typeof this.store.commitAll === "function") {
      await this.store.commitAll(dataByType);
    } else {
      logger.warn("Storage adapter does not support commitAll");
      return;
    }
  }

  async loadFromStorage(): Promise<void> {
    try {
      // Try to load type-specific data first
      if ("loadAll" in this.store && typeof this.store.loadAll === "function") {
        const dataByType = await this.store.loadAll();

        for (const [memoryType, typeData] of Object.entries(dataByType)) {
          const memoryTypeEnum = CoALAMemoryType[memoryType as keyof typeof CoALAMemoryType];
          const typeMap = this.memoriesByType.get(memoryTypeEnum);

          if (typeMap && typeData) {
            for (const [key, serializedMemory] of Object.entries(typeData)) {
              // Validate and parse memory entry
              const parseResult = CoALAMemoryEntrySchema.safeParse(serializedMemory);
              if (!parseResult.success) {
                logger.warn(`Invalid memory entry during load: ${key} (type: ${memoryType})`, {
                  error: parseResult.error,
                  serializedData: serializedMemory,
                });
                continue; // Skip invalid entries
              }

              const restoredMemory = parseResult.data;

              // Store in both global and type-specific maps
              this.memories.set(key, restoredMemory);
              typeMap.set(key, restoredMemory);
            }
          }
        }
      }
    } catch (error) {
      logger.warn("Failed to load CoALA memories from storage", { error });
    }
  }

  // Type-specific memory access methods
  getMemoriesByType(memoryType: CoALAMemoryType): CoALAMemoryEntry[] {
    const typeMap = this.memoriesByType.get(memoryType);
    return typeMap ? Array.from(typeMap.values()) : [];
  }

  getMemoryTypeStatistics(): Record<
    string,
    { count: number; avgRelevance: number; oldestEntry: Date | null }
  > {
    const stats: Record<string, { count: number; avgRelevance: number; oldestEntry: Date | null }> =
      {};

    for (const [memoryType, typeMap] of this.memoriesByType.entries()) {
      const memories = Array.from(typeMap.values());
      const relevanceScores = memories.map((m) => m.relevanceScore);
      const timestamps = memories.map((m) => m.timestamp);

      stats[memoryType] = {
        count: memories.length,
        avgRelevance:
          relevanceScores.length > 0
            ? relevanceScores.reduce((sum, score) => sum + score, 0) / relevanceScores.length
            : 0,
        oldestEntry:
          timestamps.length > 0 ? new Date(Math.min(...timestamps.map((t) => t.getTime()))) : null,
      };
    }

    return stats;
  }

  async compactMemoryType(memoryType: CoALAMemoryType): Promise<number> {
    if ("compactMemoryType" in this.store && typeof this.store.compactMemoryType === "function") {
      await this.store.compactMemoryType(memoryType);

      // Reload the specific memory type to reflect compaction
      if ("loadByType" in this.store && typeof this.store.loadByType === "function") {
        const typeData = await this.store.loadByType(memoryType);
        const typeMap = this.memoriesByType.get(memoryType);

        if (typeMap && typeData) {
          // Clear current type map
          typeMap.clear();

          // Remove from global map (will be re-added below)
          for (const [key, memory] of this.memories.entries()) {
            if (memory.memoryType === memoryType) {
              this.memories.delete(key);
            }
          }

          // Reload compacted memories
          for (const [key, serializedMemory] of Object.entries(typeData)) {
            // Validate and parse memory entry
            const parseResult = CoALAMemoryEntrySchema.safeParse(serializedMemory);
            if (!parseResult.success) {
              logger.warn(
                `Invalid memory entry during compaction reload: ${key} (type: ${memoryType})`,
                { error: parseResult.error, serializedData: serializedMemory },
              );
              continue; // Skip invalid entries
            }

            const restoredMemory = parseResult.data;

            this.memories.set(key, restoredMemory);
            typeMap.set(key, restoredMemory);
          }

          return Object.keys(typeData).length;
        }
      }
    }

    return this.getMemoriesByType(memoryType).length;
  }

  async getStorageStatistics(): Promise<unknown> {
    if (
      "getMemoryStatistics" in this.store &&
      typeof this.store.getMemoryStatistics === "function"
    ) {
      return await this.store.getMemoryStatistics();
    }

    return { lastUpdated: new Date().toISOString(), memoryTypes: this.getMemoryTypeStatistics() };
  }

  // Initialize knowledge graph for semantic memory enhancement
  private initializeKnowledgeGraph(): void {
    try {
      // Skip knowledge graph initialization for in-memory storage
      // to avoid file system access in tests
      if (this.store.constructor.name === "InMemoryStorageAdapter") {
        return;
      }
    } catch (error) {
      logger.warn("Failed to initialize knowledge graph for semantic memory", { error: { error } });
    }
  }

  // === STREAMING MEMORY METHODS ===
  // These methods support incremental memory processing for performance

  /**
   * Store a single semantic fact (streaming version)
   */
  async storeFact(fact: {
    id: string;
    content: string;
    confidence: number;
    source: string;
    timestamp: number;
    sessionId: string;
    agentId?: string;
    context?: Record<string, unknown>;
  }): Promise<void> {
    // Store as semantic memory with high confidence
    this.rememberWithMetadata(
      fact.id,
      {
        statement: fact.content,
        confidence: fact.confidence.toString(),
        source: fact.source,
        timestamp: fact.timestamp.toString(),
        sessionId: fact.sessionId,
        agentId: fact.agentId || "",
      },
      {
        memoryType: CoALAMemoryType.SEMANTIC,
        tags: ["fact", "streaming", fact.source],
        relevanceScore: fact.confidence,
        confidence: fact.confidence,
      },
    );
  }

  /**
   * Store multiple semantic facts in a batch (streaming version)
   */
  async storeFactsBatch(
    facts: Array<{
      id: string;
      content: string;
      confidence: number;
      source: string;
      timestamp: number;
      sessionId: string;
      agentId?: string;
      context?: Record<string, unknown>;
    }>,
  ): Promise<void> {
    const promises = facts.map((fact) => this.storeFact(fact));
    await Promise.all(promises);
  }

  /**
   * Store a single procedural pattern (streaming version)
   */
  async storePattern(pattern: {
    id: string;
    type: string;
    agentId: string;
    strategy: string;
    duration: number;
    inputCharacteristics: Record<string, unknown>;
    outcome: Record<string, unknown>;
    timestamp: number;
    sessionId: string;
  }): Promise<void> {
    this.rememberWithMetadata(
      pattern.id,
      {
        type: pattern.type,
        agentId: pattern.agentId,
        strategy: pattern.strategy,
        duration: pattern.duration.toString(),
        inputCharacteristics: JSON.stringify(pattern.inputCharacteristics),
        outcome: JSON.stringify(pattern.outcome),
        timestamp: pattern.timestamp.toString(),
        sessionId: pattern.sessionId,
      },
      {
        memoryType: CoALAMemoryType.PROCEDURAL,
        tags: ["pattern", pattern.type, pattern.strategy],
        relevanceScore: pattern.outcome.success ? 0.8 : 0.6,
        confidence: 0.9,
      },
    );
  }

  /**
   * Store multiple procedural patterns in a batch (streaming version)
   */
  async storePatternsBatch(
    patterns: Array<{
      id: string;
      type: string;
      agentId: string;
      strategy: string;
      duration: number;
      inputCharacteristics: Record<string, unknown>;
      outcome: Record<string, unknown>;
      timestamp: number;
      sessionId: string;
    }>,
  ): Promise<void> {
    const promises = patterns.map((pattern) => this.storePattern(pattern));
    await Promise.all(promises);
  }

  /**
   * Store a single episodic event (streaming version)
   */
  async storeEpisode(episode: {
    id: string;
    eventType: string;
    description: string;
    participants: string[];
    outcome: string;
    significance: number;
    timestamp: number;
    sessionId: string;
  }): Promise<void> {
    this.rememberWithMetadata(
      episode.id,
      {
        eventType: episode.eventType,
        description: episode.description,
        participants: episode.participants.join(","),
        outcome: episode.outcome,
        significance: episode.significance.toString(),
        timestamp: episode.timestamp.toString(),
        sessionId: episode.sessionId,
      },
      {
        memoryType: CoALAMemoryType.EPISODIC,
        tags: ["episode", episode.eventType, episode.outcome],
        relevanceScore: episode.significance,
        confidence: 0.8,
      },
    );
  }

  /**
   * Store multiple episodic events in a batch (streaming version)
   */
  async storeEpisodesBatch(
    episodes: Array<{
      id: string;
      eventType: string;
      description: string;
      participants: string[];
      outcome: string;
      significance: number;
      timestamp: number;
      sessionId: string;
    }>,
  ): Promise<void> {
    const promises = episodes.map((episode) => this.storeEpisode(episode));
    await Promise.all(promises);
  }

  /**
   * Store session summary (streaming version)
   */
  async storeSessionSummary(summary: {
    id: string;
    sessionId: string;
    totalDuration: number;
    agentCount: number;
    successRate: number;
    summary?: string;
    timestamp: number;
  }): Promise<void> {
    this.rememberWithMetadata(
      summary.id,
      {
        sessionId: summary.sessionId,
        totalDuration: summary.totalDuration.toString(),
        agentCount: summary.agentCount.toString(),
        successRate: summary.successRate.toString(),
        summary: summary.summary || "",
        timestamp: summary.timestamp.toString(),
      },
      {
        memoryType: CoALAMemoryType.EPISODIC,
        tags: ["session", "summary", "completion"],
        relevanceScore: summary.successRate,
        confidence: 0.9,
      },
    );
  }

  // === VECTOR SEARCH METHODS ===

  /**
   * Initialize vector search capabilities
   */
  async initializeVectorSearch(config?: Partial<VectorSearchConfig>): Promise<void> {
    try {
      // Initialize embedding provider using global singleton
      this.embeddingProvider = await GlobalEmbeddingProvider.getInstance();

      // Initialize vector storage
      const basePath = this.getVectorSearchBasePath();
      this.vectorSearch = new VectorSearchLocalStorageAdapter(basePath);

      // Set up configuration
      this.vectorSearchConfig = {
        embeddingProvider: this.embeddingProvider, // MECMFEmbeddingProvider extends the required interface
        storageAdapter: this.vectorSearch,
        enabledMemoryTypes: Array.from(this.vectorIndexedTypes).map((t) => t.toString()),
        autoIndexOnWrite: true,
        batchSize: 10,
        similarityThreshold: 0.7,
        ...config,
      };

      logger.info("Vector search initialized for memory types", {
        memoryTypes: Array.from(this.vectorIndexedTypes),
      });
    } catch (error) {
      logger.warn("Failed to initialize vector search", { error });
    }
  }

  private getVectorSearchBasePath(): string {
    // Use workspace-specific vector directory
    const workspaceId = this.scope.workspaceId || this.scope.id;
    return getWorkspaceVectorDir(workspaceId);
  }

  /**
   * Index a memory entry in vector search
   */
  private async indexMemoryInVectorSearch(memory: CoALAMemoryEntry): Promise<void> {
    if (
      !this.vectorSearch ||
      !this.embeddingProvider ||
      !this.vectorIndexedTypes.has(memory.memoryType)
    ) {
      return;
    }

    try {
      // Convert memory content to searchable text
      const textContent = this.extractTextFromMemory(memory);
      if (!textContent || textContent.trim().length === 0) {
        return;
      }

      // Generate embedding
      const vector = await this.embeddingProvider.generateEmbedding(textContent);

      // Create vector embedding
      const embedding: VectorEmbedding = {
        id: `${memory.memoryType}_${memory.id}`,
        vector,
        metadata: {
          memoryId: memory.id,
          memoryType: memory.memoryType,
          content: textContent,
          timestamp: memory.timestamp,
          sourceScope: memory.sourceScope,
          tags: memory.tags,
        },
      };

      // Store in vector index
      await this.vectorSearch.upsertEmbeddings([embedding]);
    } catch (error) {
      logger.error(`Failed to index memory ${memory.id} in vector search`, {
        error,
        memoryId: memory.id,
      });
    }
  }

  /**
   * Extract searchable text from memory content
   */
  private extractTextFromMemory(memory: CoALAMemoryEntry): string {
    if (typeof memory.content === "string") {
      return memory.content;
    }

    if (typeof memory.content === "object" && memory.content !== null) {
      // Try to extract meaningful text from objects
      const textFields = ["text", "content", "description", "statement", "summary", "title"];

      for (const field of textFields) {
        if (memory.content[field] && typeof memory.content[field] === "string") {
          return memory.content[field];
        }
      }

      // Fallback to JSON string with some cleanup
      return JSON.stringify(memory.content)
        .replace(/[{}[\]"]/g, " ")
        .replace(/,/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    return String(memory.content);
  }

  /**
   * Search memories using vector similarity
   */
  async searchMemoriesByVector(
    query: string,
    options?: {
      memoryTypes?: CoALAMemoryType[];
      tags?: string[];
      limit?: number;
      minSimilarity?: number;
    },
  ): Promise<Array<CoALAMemoryEntry & { similarity: number }>> {
    if (!this.vectorSearch || !this.embeddingProvider) {
      logger.warn("Vector search not available");
      return [];
    }

    try {
      // Generate query embedding
      const queryVector = await this.embeddingProvider.generateEmbedding(query);

      // Search vector index
      const searchQuery: VectorSearchQuery = {
        query,
        vector: queryVector,
        memoryTypes: options?.memoryTypes?.map((t) => t.toString()),
        tags: options?.tags,
        limit: options?.limit || 10,
        minSimilarity: options?.minSimilarity || 0.3,
        includeMetadata: true,
      };

      const results = await this.vectorSearch.search(searchQuery);

      // Convert results back to memory entries with similarity scores
      const memoryResults: Array<CoALAMemoryEntry & { similarity: number }> = [];

      for (const result of results) {
        const memory = this.memories.get(result.memoryId);
        if (memory) {
          memoryResults.push({ ...memory, similarity: result.similarity });
        }
      }

      return memoryResults;
    } catch (error) {
      logger.error("Vector search failed", { error });
      return [];
    }
  }

  /**
   * Enhanced memory retrieval for prompt enhancement using vector search
   * Automatically tokenizes the prompt and searches relevant memory types
   */
  async getRelevantMemoriesForPrompt(
    promptText: string,
    options?: {
      includeWorking?: boolean;
      includeEpisodic?: boolean;
      includeSemantic?: boolean;
      includeProcedural?: boolean;
      limit?: number;
      minSimilarity?: number;
      maxAge?: number;
      tags?: string[];
    },
  ): Promise<{
    memories: Array<CoALAMemoryEntry & { similarity?: number; source: "working" | "vector" }>;
    processedPrompt: ProcessedPrompt;
  }> {
    const {
      includeWorking = true,
      includeEpisodic = true,
      includeSemantic = true,
      includeProcedural = true,
      limit = 10,
      minSimilarity = 0.4,
      maxAge,
      tags,
    } = options || {};

    // Process the prompt for better search terms
    const processedPrompt = tokenizePrompt(promptText, {
      removeStopWords: true,
      minWordLength: 2,
      maxTokens: 50,
      includeTechnicalTerms: true,
    });

    const allMemories: Array<
      CoALAMemoryEntry & { similarity?: number; source: "working" | "vector" }
    > = [];

    // Get WORKING memories using traditional search (unchanged)
    if (includeWorking) {
      const workingMemories = this.queryMemories({
        memoryType: CoALAMemoryType.WORKING,
        content: processedPrompt.processed,
        limit: Math.ceil(limit / 4), // Allocate portion of limit to working memory
        maxAge,
        tags,
      });

      allMemories.push(
        ...workingMemories.map((memory) => ({ ...memory, source: "working" as const })),
      );
    }

    // Get vector-indexed memories (EPISODIC, SEMANTIC, PROCEDURAL)
    if (
      this.vectorSearch &&
      this.embeddingProvider &&
      (includeEpisodic || includeSemantic || includeProcedural)
    ) {
      const vectorMemoryTypes: CoALAMemoryType[] = [];

      if (includeEpisodic) vectorMemoryTypes.push(CoALAMemoryType.EPISODIC);
      if (includeSemantic) vectorMemoryTypes.push(CoALAMemoryType.SEMANTIC);
      if (includeProcedural) vectorMemoryTypes.push(CoALAMemoryType.PROCEDURAL);

      // Use the processed prompt text for vector search
      const searchText = processedPrompt.processed || promptText;

      try {
        const vectorResults = await this.searchMemoriesByVector(searchText, {
          memoryTypes: vectorMemoryTypes,
          limit: limit - allMemories.length, // Use remaining limit
          minSimilarity,
          tags,
        });

        // Filter by age if specified
        const filteredVectorResults = maxAge
          ? vectorResults.filter((memory) => {
              const age = Date.now() - memory.timestamp.getTime();
              return age <= maxAge;
            })
          : vectorResults;

        allMemories.push(
          ...filteredVectorResults.map((memory) => ({ ...memory, source: "vector" as const })),
        );
      } catch (error) {
        logger.warn("Vector search failed, falling back to text search", { error });

        // Fallback to traditional text search for vector-indexed types
        const fallbackMemories = this.queryMemories({
          content: processedPrompt.processed,
          memoryType: undefined, // Search all types
          limit: limit - allMemories.length,
          maxAge,
          tags,
        }).filter((memory) => vectorMemoryTypes.includes(memory.memoryType));

        allMemories.push(
          ...fallbackMemories.map((memory) => ({ ...memory, source: "vector" as const })),
        );
      }
    }

    // Sort by relevance (similarity for vector results, relevanceScore for others)
    allMemories.sort((a, b) => {
      const aScore = a.similarity || a.relevanceScore;
      const bScore = b.similarity || b.relevanceScore;
      return bScore - aScore;
    });

    return { memories: allMemories.slice(0, limit), processedPrompt };
  }

  /**
   * Enhanced version of queryMemories that uses vector search for non-WORKING memory types
   * while maintaining backward compatibility
   */
  async queryMemoriesEnhanced(query: CoALAMemoryQuery): Promise<CoALAMemoryEntry[]> {
    // For WORKING memory or when no content query, use traditional search
    if (
      query.memoryType === CoALAMemoryType.WORKING ||
      !query.content ||
      !this.vectorSearch ||
      !this.embeddingProvider
    ) {
      return this.queryMemories(query);
    }

    // For vector-indexed memory types with content query, use hybrid approach
    const vectorIndexedTypes = [
      CoALAMemoryType.EPISODIC,
      CoALAMemoryType.SEMANTIC,
      CoALAMemoryType.PROCEDURAL,
    ];

    const shouldUseVectorSearch =
      !query.memoryType || vectorIndexedTypes.includes(query.memoryType);

    if (shouldUseVectorSearch) {
      try {
        // Process the search content
        const processedQuery = tokenizePrompt(query.content, {
          removeStopWords: true,
          minWordLength: 2,
          includeTechnicalTerms: true,
        });

        // Use vector search
        const vectorResults = await this.searchMemoriesByVector(
          processedQuery.processed || query.content,
          {
            memoryTypes: query.memoryType ? [query.memoryType] : vectorIndexedTypes,
            tags: query.tags,
            limit: query.limit || 20,
            minSimilarity: 0.3, // Lower threshold for query compatibility
          },
        );

        // Apply additional filters from the original query
        let filteredResults = vectorResults.map((result) => {
          const { similarity, ...memory } = result;
          return memory;
        });

        if (query.minRelevance) {
          filteredResults = filteredResults.filter((m) => m.relevanceScore >= query.minRelevance!);
        }

        if (query.maxAge) {
          const cutoff = new Date(Date.now() - query.maxAge);
          filteredResults = filteredResults.filter((m) => m.timestamp >= cutoff);
        }

        if (query.sourceScope) {
          filteredResults = filteredResults.filter((m) => m.sourceScope === query.sourceScope);
        }

        return query.limit ? filteredResults.slice(0, query.limit) : filteredResults;
      } catch (error) {
        logger.warn(
          "Vector search failed in queryMemoriesEnhanced, falling back to traditional search",
          { error },
        );
        return this.queryMemories(query);
      }
    }

    // Fallback to traditional search
    return this.queryMemories(query);
  }

  /**
   * Create enriched context string for prompt enhancement using vector search
   * This is the main method used to enhance prompts with relevant memory
   */
  async enhancePromptWithMemory(
    originalPrompt: string,
    options?: {
      includeWorking?: boolean;
      includeEpisodic?: boolean;
      includeSemantic?: boolean;
      includeProcedural?: boolean;
      maxMemories?: number;
      minSimilarity?: number;
      contextFormat?: "detailed" | "summary" | "bullets";
    },
  ): Promise<{
    enhancedPrompt: string;
    memoriesUsed: number;
    memoryContext: string;
    processedPrompt: ProcessedPrompt;
  }> {
    const {
      includeWorking = true,
      includeEpisodic = true,
      includeSemantic = true,
      includeProcedural = true,
      maxMemories = 8,
      minSimilarity = 0.4,
      contextFormat = "summary",
    } = options || {};

    // Get relevant memories using vector search
    const memoryResults = await this.getRelevantMemoriesForPrompt(originalPrompt, {
      includeWorking,
      includeEpisodic,
      includeSemantic,
      includeProcedural,
      limit: maxMemories,
      minSimilarity,
    });

    if (memoryResults.memories.length === 0) {
      return {
        enhancedPrompt: originalPrompt,
        memoriesUsed: 0,
        memoryContext: "",
        processedPrompt: memoryResults.processedPrompt,
      };
    }

    // Format memory context based on requested format
    const memoryContext = this.formatMemoryContext(memoryResults.memories, contextFormat);

    // Create enhanced prompt with memory context
    const enhancedPrompt = this.buildEnhancedPrompt(
      originalPrompt,
      memoryContext,
      memoryResults.memories.length,
    );

    return {
      enhancedPrompt,
      memoriesUsed: memoryResults.memories.length,
      memoryContext,
      processedPrompt: memoryResults.processedPrompt,
    };
  }

  /**
   * Format memory context for prompt enhancement
   */
  private formatMemoryContext(
    memories: Array<CoALAMemoryEntry & { similarity?: number; source: "working" | "vector" }>,
    format: "detailed" | "summary" | "bullets",
  ): string {
    if (memories.length === 0) return "";

    const memoryTypeGroups = {
      working: memories.filter((m) => m.memoryType === CoALAMemoryType.WORKING),
      episodic: memories.filter((m) => m.memoryType === CoALAMemoryType.EPISODIC),
      semantic: memories.filter((m) => m.memoryType === CoALAMemoryType.SEMANTIC),
      procedural: memories.filter((m) => m.memoryType === CoALAMemoryType.PROCEDURAL),
    };

    let context = "";

    switch (format) {
      case "detailed":
        context = this.formatDetailedContext(memoryTypeGroups);
        break;
      case "summary":
        context = this.formatSummaryContext(memoryTypeGroups);
        break;
      case "bullets":
        context = this.formatBulletContext(memoryTypeGroups);
        break;
    }

    return context;
  }

  private formatDetailedContext(memoryTypeGroups: {
    working: CoALAMemoryEntry[];
    procedural: CoALAMemoryEntry[];
    semantic: CoALAMemoryEntry[];
    episodic: CoALAMemoryEntry[];
  }): string {
    let context = "\n## RELEVANT MEMORY CONTEXT\n\n";

    if ((memoryTypeGroups.working || []).length > 0) {
      context += "### Current Working Context:\n";
      (memoryTypeGroups.working || []).forEach((memory, index) => {
        context += `${index + 1}. **${memory.id}**: ${this.extractMemoryContent(memory.content)}\n`;
      });
      context += "\n";
    }

    if ((memoryTypeGroups.procedural || []).length > 0) {
      context += "### Relevant Procedures & Workflows:\n";
      (memoryTypeGroups.procedural || []).forEach((memory, index) => {
        context += `${index + 1}. **${memory.id}**: ${this.extractMemoryContent(memory.content)}\n`;
      });
      context += "\n";
    }

    if ((memoryTypeGroups.semantic || []).length > 0) {
      context += "### Relevant Knowledge:\n";
      (memoryTypeGroups.semantic || []).forEach((memory, index) => {
        context += `${index + 1}. **${memory.id}**: ${this.extractMemoryContent(memory.content)}\n`;
      });
      context += "\n";
    }

    if ((memoryTypeGroups.episodic || []).length > 0) {
      context += "### Past Experiences:\n";
      (memoryTypeGroups.episodic || []).forEach((memory, index) => {
        context += `${index + 1}. **${memory.id}**: ${this.extractMemoryContent(memory.content)}\n`;
      });
    }

    return context;
  }

  private formatSummaryContext(memoryTypeGroups: {
    working: CoALAMemoryEntry[];
    procedural: CoALAMemoryEntry[];
    semantic: CoALAMemoryEntry[];
    episodic: CoALAMemoryEntry[];
  }): string {
    const contextParts: string[] = [];

    if ((memoryTypeGroups.working || []).length > 0) {
      contextParts.push(
        `Current context: ${(memoryTypeGroups.working || [])
          .map((m) => this.extractMemoryContent(m.content, 100))
          .join("; ")}`,
      );
    }

    if ((memoryTypeGroups.procedural || []).length > 0) {
      contextParts.push(
        `Relevant procedures: ${(memoryTypeGroups.procedural || [])
          .map((m) => this.extractMemoryContent(m.content, 100))
          .join("; ")}`,
      );
    }

    if ((memoryTypeGroups.semantic || []).length > 0) {
      contextParts.push(
        `Related knowledge: ${(memoryTypeGroups.semantic || [])
          .map((m) => this.extractMemoryContent(m.content, 100))
          .join("; ")}`,
      );
    }

    if ((memoryTypeGroups.episodic || []).length > 0) {
      contextParts.push(
        `Past experiences: ${(memoryTypeGroups.episodic || [])
          .map((m) => this.extractMemoryContent(m.content, 100))
          .join("; ")}`,
      );
    }

    return contextParts.length > 0 ? `\n[Memory Context: ${contextParts.join(" | ")}]\n\n` : "";
  }

  private formatBulletContext(memoryTypeGroups: {
    working: CoALAMemoryEntry[];
    procedural: CoALAMemoryEntry[];
    semantic: CoALAMemoryEntry[];
    episodic: CoALAMemoryEntry[];
  }): string {
    const bullets: string[] = [];

    (memoryTypeGroups.working || []).forEach((m) => {
      bullets.push(`• [Working] ${this.extractMemoryContent(m.content, 150)}`);
    });

    (memoryTypeGroups.procedural || []).forEach((m) => {
      bullets.push(`• [Procedure] ${this.extractMemoryContent(m.content, 150)}`);
    });

    (memoryTypeGroups.semantic || []).forEach((m) => {
      bullets.push(`• [Knowledge] ${this.extractMemoryContent(m.content, 150)}`);
    });

    (memoryTypeGroups.episodic || []).forEach((m) => {
      bullets.push(`• [Experience] ${this.extractMemoryContent(m.content, 150)}`);
    });

    return bullets.length > 0 ? `\n## Relevant Memory:\n${bullets.join("\n")}\n\n` : "";
  }

  private extractMemoryContent(
    content: string | Record<string, string>,
    maxLength?: number,
  ): string {
    let text = "";

    if (typeof content === "string") {
      text = content;
    } else if (typeof content === "object" && content !== null) {
      // Extract meaningful fields
      const textFields = ["title", "description", "summary", "content", "text", "statement"];

      for (const field of textFields) {
        if (content[field] && typeof content[field] === "string") {
          text = content[field];
          break;
        }
      }

      if (!text) {
        text = JSON.stringify(content);
      }
    } else {
      text = String(content);
    }

    // Clean and truncate if needed
    text = text.replace(/\s+/g, " ").trim();

    if (maxLength && text.length > maxLength) {
      text = text.substring(0, maxLength - 3) + "...";
    }

    return text;
  }

  private buildEnhancedPrompt(
    originalPrompt: string,
    memoryContext: string,
    memoryCount: number,
  ): string {
    if (!memoryContext || memoryCount === 0) {
      return originalPrompt;
    }

    // Insert memory context before the original prompt
    return `${memoryContext}## USER REQUEST\n\n${originalPrompt}`;
  }

  /**
   * Get vector search statistics
   */
  async getVectorSearchStats(): Promise<unknown> {
    if (!this.vectorSearch) {
      return null;
    }

    try {
      return await this.vectorSearch.getStats();
    } catch (error) {
      logger.error("Failed to get vector search stats", { error });
      return null;
    }
  }

  /**
   * Rebuild vector index for all indexed memory types
   */
  async rebuildVectorIndex(): Promise<void> {
    if (!this.vectorSearch) {
      logger.warn("Vector search not available for index rebuild");
      return;
    }

    try {
      // Clear existing index
      await this.vectorSearch.clear();

      // Reindex all memories of indexed types
      const memoriesToIndex: CoALAMemoryEntry[] = [];

      for (const memoryType of this.vectorIndexedTypes) {
        const typeMemories = Array.from(this.memoriesByType.get(memoryType)?.values() || []);
        memoriesToIndex.push(...typeMemories);
      }

      logger.info("Rebuilding vector index", { memoryCount: memoriesToIndex.length });

      // Index in batches
      const batchSize = this.vectorSearchConfig?.batchSize || 10;
      for (let i = 0; i < memoriesToIndex.length; i += batchSize) {
        const batch = memoriesToIndex.slice(i, i + batchSize);

        for (const memory of batch) {
          await this.indexMemoryInVectorSearch(memory);
        }
      }

      logger.info("Vector index rebuild completed");
    } catch (error) {
      logger.error("Failed to rebuild vector index", { error });
    }
  }

  // Cleanup
  async dispose(): Promise<void> {
    // Stop cognitive loop
    if (this.loopTimer) {
      clearInterval(this.loopTimer);
      this.loopTimer = undefined;
    }

    // Clear debounce timer
    if (this.commitDebounceTimer) {
      clearTimeout(this.commitDebounceTimer);
      this.commitDebounceTimer = undefined;
    }

    // Flush any pending commits
    if (this.pendingCommit) {
      await this.commitToStorage();
    }
  }
}

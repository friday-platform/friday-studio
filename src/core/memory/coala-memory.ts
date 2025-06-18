/**
 * CoALA (Cognitive Architectures as Language Agents) Memory Implementation for Atlas
 *
 * This implementation provides cognitive memory systems with:
 * - Multi-layered memory hierarchies (working, episodic, semantic, procedural)
 * - Adaptive retrieval based on context and relevance
 * - Cross-agent memory sharing and reflection
 * - Cognitive loops for memory consolidation and adaptation
 */

import type {
  IAtlasScope,
  ICoALAMemoryStorageAdapter,
  ITempestMemoryManager,
  ITempestMemoryStorageAdapter,
} from "../../types/core.ts";
import { CoALALocalFileStorageAdapter } from "../../storage/coala-local.ts";
import { ExtractedFact, KnowledgeGraphManager, KnowledgeGraphQuery } from "./knowledge-graph.ts";
import { KnowledgeGraphLocalStorageAdapter } from "../../storage/knowledge-graph-local.ts";

export interface CoALAMemoryEntry {
  id: string;
  content: any;
  timestamp: Date;
  accessCount: number;
  lastAccessed: Date;
  memoryType: CoALAMemoryType;
  relevanceScore: number;
  sourceScope: string;
  associations: string[]; // IDs of related memories
  tags: string[];
  confidence: number; // How confident we are in this memory
  decayRate: number; // How quickly this memory should fade
}

export enum CoALAMemoryType {
  WORKING = "working", // Short-term, active processing
  EPISODIC = "episodic", // Specific experiences and events
  SEMANTIC = "semantic", // General knowledge and concepts
  PROCEDURAL = "procedural", // How-to knowledge and skills
  CONTEXTUAL = "contextual", // Session/agent specific context
}

export interface CoALACognitiveLoop {
  reflect(): CoALAMemoryEntry[];
  consolidate(): void;
  prune(): void;
  adapt(feedback: any): void;
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

export class CoALAMemoryManager implements ITempestMemoryManager, CoALACognitiveLoop {
  private store: ICoALAMemoryStorageAdapter;
  private memories: Map<string, CoALAMemoryEntry> = new Map();
  private memoriesByType: Map<CoALAMemoryType, Map<string, CoALAMemoryEntry>> = new Map();
  private scope: IAtlasScope;
  private cognitiveLoopInterval: number = 300000; // 5 minutes
  private loopTimer?: number;
  private knowledgeGraph?: KnowledgeGraphManager;

  constructor(
    scope: IAtlasScope,
    storageAdapter?: ITempestMemoryStorageAdapter | ICoALAMemoryStorageAdapter,
    enableCognitiveLoop: boolean = true,
  ) {
    this.scope = scope;

    // Use CoALA storage adapter if provided, otherwise create new one
    if (storageAdapter && "commitByType" in storageAdapter) {
      this.store = storageAdapter as ICoALAMemoryStorageAdapter;
    } else if (storageAdapter) {
      // Wrap legacy adapter for backwards compatibility
      this.store = new CoALALocalFileStorageAdapter();
    } else {
      this.store = new CoALALocalFileStorageAdapter();
    }

    // Initialize memory type maps
    Object.values(CoALAMemoryType).forEach((type) => {
      this.memoriesByType.set(type, new Map());
    });

    // Initialize knowledge graph for semantic memory enhancement
    this.initializeKnowledgeGraph();

    this.loadFromStorage();

    if (enableCognitiveLoop) {
      this.startCognitiveLoop();
    }
  }

  // ITempestMemoryManager implementation (legacy compatibility)
  remember(key: string, value: any): void {
    this.rememberWithMetadata(key, value, {
      memoryType: CoALAMemoryType.WORKING,
      tags: [],
      relevanceScore: 0.5,
    });
  }

  recall(key: string): any {
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
    content: any,
    metadata: {
      memoryType: CoALAMemoryType;
      tags: string[];
      relevanceScore: number;
      associations?: string[];
      confidence?: number;
      decayRate?: number;
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
      sourceScope: this.scope.id,
      associations: metadata.associations || [],
      tags: metadata.tags,
      confidence: metadata.confidence || 1.0,
      decayRate: metadata.decayRate || 0.1,
    };

    // Store in both global and type-specific maps
    this.memories.set(key, memory);
    const typeMap = this.memoriesByType.get(metadata.memoryType);
    if (typeMap) {
      typeMap.set(key, memory);
    }

    this.updateAssociations(memory);
    this.commitToStorage();
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
        JSON.stringify(m.content).toLowerCase().includes(query.content!.toLowerCase())
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
    const candidatesForReflection = Array.from(this.memories.values())
      .filter((memory) => {
        const age = Date.now() - memory.timestamp.getTime();
        const timeSinceAccess = Date.now() - memory.lastAccessed.getTime();

        // Reflect on frequently accessed memories or old unaccessed ones
        return (memory.accessCount > 5 && age > 3600000) || // 1 hour old, frequently accessed
          (timeSinceAccess > 86400000); // 24 hours since last access
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

    this.commitToStorage();
  }

  prune(): void {
    // Remove low-relevance, old memories to maintain performance
    const memoriesToPrune = Array.from(this.memories.values())
      .filter((memory) => {
        const age = Date.now() - memory.timestamp.getTime();
        const decayedRelevance = memory.relevanceScore *
          Math.exp(-memory.decayRate * age / 86400000); // Daily decay

        return decayedRelevance < 0.1 && age > 604800000; // 1 week old, very low relevance
      });

    for (const memory of memoriesToPrune) {
      // Remove from both global and type-specific maps
      this.memories.delete(memory.id);
      const typeMap = this.memoriesByType.get(memory.memoryType);
      if (typeMap) {
        typeMap.delete(memory.id);
      }
    }

    this.commitToStorage();
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
        Math.min(1, memory.confidence + (feedback.relevanceAdjustment * 0.1)),
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

  forget(key: string): void {
    const memory = this.memories.get(key);
    if (memory) {
      // Remove from both global and type-specific maps
      this.memories.delete(key);
      const typeMap = this.memoriesByType.get(memory.memoryType);
      if (typeMap) {
        typeMap.delete(key);
      }
    }
    this.commitToStorage();
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
        console.warn("CoALA cognitive loop error:", error);
      }
    }, this.cognitiveLoopInterval);
  }

  private async commitToStorage(): Promise<void> {
    // Organize memories by type for multi-file storage
    const dataByType: Record<string, any> = {};

    for (const [memoryType, typeMap] of this.memoriesByType.entries()) {
      if (typeMap.size > 0) {
        const serializedTypeMemories = Object.fromEntries(
          Array.from(typeMap.entries()).map(([key, memory]) => [
            key,
            {
              ...memory,
              timestamp: memory.timestamp.toISOString(),
              lastAccessed: memory.lastAccessed.toISOString(),
            },
          ]),
        );
        dataByType[memoryType] = serializedTypeMemories;
      }
    }

    // Use type-specific storage if available
    if ("commitAll" in this.store && typeof this.store.commitAll === "function") {
      await (this.store as any).commitAll(dataByType);
    } else {
      // Fallback to legacy storage (combine all types)
      const allMemories = Object.fromEntries(
        Array.from(this.memories.entries()).map(([key, memory]) => [
          key,
          {
            ...memory,
            timestamp: memory.timestamp.toISOString(),
            lastAccessed: memory.lastAccessed.toISOString(),
          },
        ]),
      );
      await (this.store as ITempestMemoryStorageAdapter).commit(allMemories);
    }
  }

  private async loadFromStorage(): Promise<void> {
    try {
      // Try to load type-specific data first
      if ("loadAll" in this.store && typeof this.store.loadAll === "function") {
        const dataByType = await (this.store as any).loadAll();

        for (const [memoryType, typeData] of Object.entries(dataByType)) {
          const memoryTypeEnum = memoryType as CoALAMemoryType;
          const typeMap = this.memoriesByType.get(memoryTypeEnum);

          if (typeMap && typeData) {
            for (const [key, serializedMemory] of Object.entries(typeData)) {
              const memory = serializedMemory as any;
              const restoredMemory = {
                ...memory,
                timestamp: new Date(memory.timestamp),
                lastAccessed: new Date(memory.lastAccessed),
              };

              // Store in both global and type-specific maps
              this.memories.set(key, restoredMemory);
              typeMap.set(key, restoredMemory);
            }
          }
        }
      } else {
        // Fallback to legacy loading
        const data = await (this.store as ITempestMemoryStorageAdapter).load();
        if (data) {
          for (const [key, serializedMemory] of Object.entries(data)) {
            const memory = serializedMemory as any;
            const restoredMemory = {
              ...memory,
              timestamp: new Date(memory.timestamp),
              lastAccessed: new Date(memory.lastAccessed),
            };

            // Store in global map
            this.memories.set(key, restoredMemory);

            // Store in type-specific map
            const typeMap = this.memoriesByType.get(restoredMemory.memoryType);
            if (typeMap) {
              typeMap.set(key, restoredMemory);
            }
          }
        }
      }
    } catch (error) {
      console.warn("Failed to load CoALA memories from storage:", error);
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
    const stats: Record<string, any> = {};

    for (const [memoryType, typeMap] of this.memoriesByType.entries()) {
      const memories = Array.from(typeMap.values());
      const relevanceScores = memories.map((m) => m.relevanceScore);
      const timestamps = memories.map((m) => m.timestamp);

      stats[memoryType] = {
        count: memories.length,
        avgRelevance: relevanceScores.length > 0
          ? relevanceScores.reduce((sum, score) => sum + score, 0) / relevanceScores.length
          : 0,
        oldestEntry: timestamps.length > 0
          ? new Date(Math.min(...timestamps.map((t) => t.getTime())))
          : null,
      };
    }

    return stats;
  }

  async compactMemoryType(memoryType: CoALAMemoryType): Promise<number> {
    if ("compactMemoryType" in this.store && typeof this.store.compactMemoryType === "function") {
      await (this.store as any).compactMemoryType(memoryType);

      // Reload the specific memory type to reflect compaction
      if ("loadByType" in this.store && typeof this.store.loadByType === "function") {
        const typeData = await (this.store as any).loadByType(memoryType);
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
            const memory = serializedMemory as any;
            const restoredMemory = {
              ...memory,
              timestamp: new Date(memory.timestamp),
              lastAccessed: new Date(memory.lastAccessed),
            };

            this.memories.set(key, restoredMemory);
            typeMap.set(key, restoredMemory);
          }

          return Object.keys(typeData).length;
        }
      }
    }

    return this.getMemoriesByType(memoryType).length;
  }

  async getStorageStatistics(): Promise<any> {
    if (
      "getMemoryStatistics" in this.store && typeof this.store.getMemoryStatistics === "function"
    ) {
      return await (this.store as any).getMemoryStatistics();
    }

    return {
      lastUpdated: new Date().toISOString(),
      memoryTypes: this.getMemoryTypeStatistics(),
    };
  }

  // Initialize knowledge graph for semantic memory enhancement
  private initializeKnowledgeGraph(): void {
    try {
      // Get base path for storage - assume we can get this from the scope or store
      const basePath = this.getKnowledgeGraphBasePath();
      const kgStorageAdapter = new KnowledgeGraphLocalStorageAdapter(basePath);
      this.knowledgeGraph = new KnowledgeGraphManager(kgStorageAdapter, this.scope.id);
    } catch (error) {
      console.warn("Failed to initialize knowledge graph for semantic memory:", error);
    }
  }

  private getKnowledgeGraphBasePath(): string {
    // Try to extract base path from existing storage adapter
    if (this.store instanceof CoALALocalFileStorageAdapter) {
      // Access the basePath if available
      return `${(this.store as any).basePath || "./.atlas/memory"}/knowledge-graph`;
    }
    // Fallback path
    return `./.atlas/memory/knowledge-graph`;
  }

  // Store facts in knowledge graph (called from semantic memory operations)
  async storeFactsInKnowledgeGraph(facts: ExtractedFact[]): Promise<string[]> {
    if (!this.knowledgeGraph) {
      console.warn("Knowledge graph not available for fact storage");
      return [];
    }

    try {
      return await this.knowledgeGraph.storeFacts(facts);
    } catch (error) {
      console.error("Error storing facts in knowledge graph:", error);
      return [];
    }
  }

  // Query knowledge graph for semantic memory enhancement
  async queryKnowledgeGraph(query: KnowledgeGraphQuery): Promise<{
    entities: any[];
    relationships: any[];
    facts: any[];
  }> {
    if (!this.knowledgeGraph) {
      return { entities: [], relationships: [], facts: [] };
    }

    try {
      return await this.knowledgeGraph.queryKnowledge(query);
    } catch (error) {
      console.error("Error querying knowledge graph:", error);
      return { entities: [], relationships: [], facts: [] };
    }
  }

  // Get semantic facts related to a query
  async getSemanticFacts(searchTerm: string, limit: number = 10): Promise<any[]> {
    if (!this.knowledgeGraph) {
      return [];
    }

    try {
      const results = await this.knowledgeGraph.queryKnowledge({
        search: searchTerm,
        limit,
      });
      return results.facts;
    } catch (error) {
      console.error("Error getting semantic facts:", error);
      return [];
    }
  }

  // Get workspace knowledge summary
  async getWorkspaceKnowledgeSummary(): Promise<any> {
    if (!this.knowledgeGraph) {
      return null;
    }

    try {
      return await this.knowledgeGraph.getWorkspaceKnowledgeSummary();
    } catch (error) {
      console.error("Error getting workspace knowledge summary:", error);
      return null;
    }
  }

  // Enhanced semantic memory storage that also updates knowledge graph
  async rememberSemanticFact(key: string, fact: any, metadata?: {
    memoryType: CoALAMemoryType;
    tags: string[];
    relevanceScore: number;
    associations?: string[];
    confidence?: number;
    decayRate?: number;
  }): Promise<void> {
    // Store in regular semantic memory
    if (metadata) {
      await this.rememberWithMetadata(key, fact, metadata);
    } else {
      this.remember(key, fact);
    }

    // If this is a structured fact, also store in knowledge graph
    if (this.knowledgeGraph && this.isStructuredFact(fact)) {
      try {
        const extractedFacts = this.convertToExtractedFacts(fact, key);
        await this.knowledgeGraph.storeFacts(extractedFacts);
      } catch (error) {
        console.warn("Failed to store fact in knowledge graph:", error);
      }
    }
  }

  // Check if a fact is structured enough for knowledge graph
  private isStructuredFact(fact: any): boolean {
    return (
      fact &&
      (fact.statement || fact.entities || fact.relationships) &&
      typeof fact === "object"
    );
  }

  // Convert a fact to ExtractedFact format
  private convertToExtractedFacts(fact: any, key: string): ExtractedFact[] {
    if (fact.statement && fact.entities && fact.relationships) {
      // Already in ExtractedFact format
      return [fact as ExtractedFact];
    }

    // Convert simple fact to ExtractedFact format
    return [{
      type: "general_fact",
      statement: fact.statement || JSON.stringify(fact),
      entities: fact.entities || [],
      relationships: fact.relationships || [],
      confidence: fact.confidence || 0.7,
      context: `Stored as semantic memory: ${key}`,
    }];
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
    context?: Record<string, any>;
  }): Promise<void> {
    // Store as semantic memory with high confidence
    this.rememberWithMetadata(fact.id, {
      statement: fact.content,
      confidence: fact.confidence,
      source: fact.source,
      timestamp: fact.timestamp,
      sessionId: fact.sessionId,
      agentId: fact.agentId,
      context: fact.context,
    }, {
      memoryType: CoALAMemoryType.SEMANTIC,
      tags: ["fact", "streaming", fact.source],
      relevanceScore: fact.confidence,
      confidence: fact.confidence,
    });
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
      context?: Record<string, any>;
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
    inputCharacteristics: Record<string, any>;
    outcome: Record<string, any>;
    timestamp: number;
    sessionId: string;
  }): Promise<void> {
    this.rememberWithMetadata(pattern.id, {
      type: pattern.type,
      agentId: pattern.agentId,
      strategy: pattern.strategy,
      duration: pattern.duration,
      inputCharacteristics: pattern.inputCharacteristics,
      outcome: pattern.outcome,
      timestamp: pattern.timestamp,
      sessionId: pattern.sessionId,
    }, {
      memoryType: CoALAMemoryType.PROCEDURAL,
      tags: ["pattern", pattern.type, pattern.strategy],
      relevanceScore: pattern.outcome.success ? 0.8 : 0.6,
      confidence: 0.9,
    });
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
      inputCharacteristics: Record<string, any>;
      outcome: Record<string, any>;
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
    this.rememberWithMetadata(episode.id, {
      eventType: episode.eventType,
      description: episode.description,
      participants: episode.participants,
      outcome: episode.outcome,
      significance: episode.significance,
      timestamp: episode.timestamp,
      sessionId: episode.sessionId,
    }, {
      memoryType: CoALAMemoryType.EPISODIC,
      tags: ["episode", episode.eventType, episode.outcome],
      relevanceScore: episode.significance,
      confidence: 0.8,
    });
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
    this.rememberWithMetadata(summary.id, {
      sessionId: summary.sessionId,
      totalDuration: summary.totalDuration,
      agentCount: summary.agentCount,
      successRate: summary.successRate,
      summary: summary.summary,
      timestamp: summary.timestamp,
    }, {
      memoryType: CoALAMemoryType.EPISODIC,
      tags: ["session", "summary", "completion"],
      relevanceScore: summary.successRate,
      confidence: 0.9,
    });
  }

  // Cleanup
  dispose(): void {
    if (this.loopTimer) {
      clearInterval(this.loopTimer);
    }
  }
}

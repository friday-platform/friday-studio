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
import { LocalFileStorageAdapter } from "../../storage/local.ts";

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
  reflect(): Promise<CoALAMemoryEntry[]>;
  consolidate(): Promise<void>;
  prune(): Promise<void>;
  adapt(feedback: any): Promise<void>;
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
  async reflect(): Promise<CoALAMemoryEntry[]> {
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

  async consolidate(): Promise<void> {
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

  async prune(): Promise<void> {
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

  async adapt(feedback: { memoryId: string; relevanceAdjustment: number }): Promise<void> {
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
    this.loopTimer = setInterval(async () => {
      try {
        await this.reflect();
        await this.consolidate();
        await this.prune();
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

  // Cleanup
  dispose(): void {
    if (this.loopTimer) {
      clearInterval(this.loopTimer);
    }
  }
}

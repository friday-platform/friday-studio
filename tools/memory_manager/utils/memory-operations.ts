/**
 * Memory Operations
 *
 * Provides CRUD operations for memory entries
 */

import {
  CoALAMemoryType,
  type MemoryEntry,
  type MemoryOperations,
  type MemoryStorage,
  type VectorSearchResult,
} from "../types/memory-types.ts";

export class AtlasMemoryOperations implements MemoryOperations {
  private storage: MemoryStorage;
  private data: Record<CoALAMemoryType, Record<string, MemoryEntry>> = {
    [CoALAMemoryType.WORKING]: {},
    [CoALAMemoryType.EPISODIC]: {},
    [CoALAMemoryType.SEMANTIC]: {},
    [CoALAMemoryType.PROCEDURAL]: {},
    [CoALAMemoryType.CONTEXTUAL]: {},
  };

  constructor(storage: MemoryStorage) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    this.data = await this.storage.loadAll();
  }

  async create(
    type: CoALAMemoryType,
    key: string,
    content: unknown,
    metadata?: Partial<MemoryEntry>,
  ): Promise<void> {
    const now = new Date();

    const entry: MemoryEntry = {
      id: key,
      content,
      timestamp: now,
      accessCount: 0,
      lastAccessed: now,
      memoryType: type,
      relevanceScore: metadata?.relevanceScore ?? 0.5,
      sourceScope: metadata?.sourceScope ?? "memory-manager",
      associations: metadata?.associations ?? [],
      tags: metadata?.tags ?? [],
      confidence: metadata?.confidence ?? 1.0,
      decayRate: metadata?.decayRate ?? 0.1,
      ...metadata,
    };

    // Store in local data structure
    this.data[type][key] = entry;

    // Also save directly to CoALA manager for vector indexing
    try {
      const loader = this.storage;
      if (loader.getCoALAManagerPublic) {
        const manager = await loader.getCoALAManagerPublic();
        await manager.remember(key, content, {
          memoryType: type,
          relevanceScore: entry.relevanceScore,
          sourceScope: entry.sourceScope,
          tags: entry.tags,
          confidence: entry.confidence,
          decayRate: entry.decayRate,
          associations: entry.associations,
        });
      }
    } catch (error) {
      console.warn(`Failed to index memory ${key} for vector search:`, error);
    }
  }

  read(type: CoALAMemoryType, key: string): Promise<MemoryEntry | null> {
    const entry = this.data[type][key];
    if (entry) {
      // Update access patterns
      entry.accessCount++;
      entry.lastAccessed = new Date();
      return Promise.resolve(entry);
    }
    return Promise.resolve(null);
  }

  update(
    type: CoALAMemoryType,
    key: string,
    updates: Partial<MemoryEntry>,
  ): Promise<void> {
    const entry = this.data[type][key];
    if (!entry) {
      throw new Error(`Memory entry '${key}' not found in ${type} memory`);
    }

    // Update entry while preserving type safety
    Object.assign(entry, updates);
    entry.lastAccessed = new Date();
    return Promise.resolve();
  }

  delete(type: CoALAMemoryType, key: string): Promise<void> {
    if (!this.data[type][key]) {
      throw new Error(`Memory entry '${key}' not found in ${type} memory`);
    }

    delete this.data[type][key];
    return Promise.resolve();
  }

  list(type: CoALAMemoryType): Promise<MemoryEntry[]> {
    return Promise.resolve(
      Object.values(this.data[type]).sort((a, b) =>
        b.lastAccessed.getTime() - a.lastAccessed.getTime()
      ),
    );
  }

  async search(type: CoALAMemoryType, query: string): Promise<MemoryEntry[]> {
    // For vector-indexed memory types (EPISODIC, SEMANTIC, PROCEDURAL), use vector search if available
    const vectorIndexedTypes = new Set([
      CoALAMemoryType.EPISODIC,
      CoALAMemoryType.SEMANTIC,
      CoALAMemoryType.PROCEDURAL,
    ]);

    if (vectorIndexedTypes.has(type)) {
      try {
        const loader = this.storage;
        if (loader.getCoALAManagerPublic) {
          const manager = await loader.getCoALAManagerPublic();

          // Try vector search first for indexed memory types
          try {
            const vectorResults = await manager.searchMemoriesByVector(query, {
              memoryTypes: [type],
              limit: 50,
              minSimilarity: 0.3,
            });

            if (vectorResults.length > 0) {
              return vectorResults.map((memory: any) => ({
                id: memory.id,
                content: memory.content,
                timestamp: memory.timestamp,
                accessCount: memory.accessCount,
                lastAccessed: memory.lastAccessed,
                memoryType: memory.memoryType,
                relevanceScore: memory.relevanceScore,
                sourceScope: memory.sourceScope,
                associations: memory.associations,
                tags: memory.tags,
                confidence: memory.confidence,
                decayRate: memory.decayRate,
              }));
            }
          } catch (error) {
            console.warn(`Vector search failed for ${type}, continuing with fallback:`, error);
          }
        }
      } catch (error) {
        console.warn(`Vector search failed for ${type}, falling back to text search:`, error);
      }
    }

    // Fallback to traditional text-based search for WORKING/CONTEXTUAL memory or when vector search fails
    const entries = await this.list(type);
    const lowerQuery = query.toLowerCase();

    return entries.filter((entry) => {
      // Search in key/id
      if (entry.id.toLowerCase().includes(lowerQuery)) {
        return true;
      }

      // Search in content (convert to string)
      const contentStr = typeof entry.content === "string"
        ? entry.content
        : JSON.stringify(entry.content);
      if (contentStr.toLowerCase().includes(lowerQuery)) {
        return true;
      }

      // Search in tags
      if (entry.tags.some((tag) => tag.toLowerCase().includes(lowerQuery))) {
        return true;
      }

      // Search in source scope
      if (entry.sourceScope.toLowerCase().includes(lowerQuery)) {
        return true;
      }

      return false;
    });
  }

  save(): Promise<void> {
    return this.storage.saveAll(this.data);
  }

  async reload(): Promise<void> {
    this.data = await this.storage.loadAll();
  }

  // Additional utility methods

  getAll(): Record<CoALAMemoryType, Record<string, MemoryEntry>> {
    return this.data;
  }

  getAllByType(type: CoALAMemoryType): Record<string, MemoryEntry> {
    return { ...this.data[type] };
  }

  getStats(): Record<CoALAMemoryType, {
    count: number;
    totalRelevance: number;
    avgRelevance: number;
    mostRecent?: Date;
    oldestEntry?: Date;
  }> {
    const stats: Record<CoALAMemoryType, {
      count: number;
      totalRelevance: number;
      avgRelevance: number;
      mostRecent?: Date;
      oldestEntry?: Date;
    }> = {
      [CoALAMemoryType.WORKING]: { count: 0, totalRelevance: 0, avgRelevance: 0 },
      [CoALAMemoryType.EPISODIC]: { count: 0, totalRelevance: 0, avgRelevance: 0 },
      [CoALAMemoryType.SEMANTIC]: { count: 0, totalRelevance: 0, avgRelevance: 0 },
      [CoALAMemoryType.PROCEDURAL]: { count: 0, totalRelevance: 0, avgRelevance: 0 },
      [CoALAMemoryType.CONTEXTUAL]: { count: 0, totalRelevance: 0, avgRelevance: 0 },
    };

    for (const [memoryType, entries] of Object.entries(this.data)) {
      const entryValues = Object.values(entries);
      const timestamps = entryValues.map((e) => e.timestamp);

      stats[memoryType as CoALAMemoryType] = {
        count: entryValues.length,
        totalRelevance: entryValues.reduce(
          (sum, e) => sum + e.relevanceScore,
          0,
        ),
        avgRelevance: entryValues.length > 0
          ? entryValues.reduce((sum, e) => sum + e.relevanceScore, 0) /
            entryValues.length
          : 0,
        mostRecent: timestamps.length > 0
          ? new Date(Math.max(...timestamps.map((t) => t.getTime())))
          : undefined,
        oldestEntry: timestamps.length > 0
          ? new Date(Math.min(...timestamps.map((t) => t.getTime())))
          : undefined,
      };
    }

    return stats;
  }

  validateEntry(entry: Partial<MemoryEntry>): string[] {
    const errors: string[] = [];

    if (!entry.id || entry.id.trim() === "") {
      errors.push("ID is required");
    }

    if (entry.content === undefined || entry.content === null) {
      errors.push("Content is required");
    }

    if (
      entry.relevanceScore !== undefined &&
      (entry.relevanceScore < 0 || entry.relevanceScore > 1)
    ) {
      errors.push("Relevance score must be between 0 and 1");
    }

    if (
      entry.confidence !== undefined &&
      (entry.confidence < 0 || entry.confidence > 1)
    ) {
      errors.push("Confidence must be between 0 and 1");
    }

    if (entry.decayRate !== undefined && entry.decayRate < 0) {
      errors.push("Decay rate must be non-negative");
    }

    return errors;
  }

  async vectorSearch(query: string): Promise<VectorSearchResult[]> {
    try {
      // Use the storage's CoALA manager directly for vector search
      const loader = this.storage;
      if (loader.getCoALAManagerPublic) {
        const manager = await loader.getCoALAManagerPublic();

        // Perform vector search across all indexed memory types using the updated Atlas interface
        const results = await manager.getRelevantMemoriesForPrompt(
          query,
          {
            includeWorking: false, // WORKING memory doesn't use vector search
            includeEpisodic: true,
            includeSemantic: true,
            includeProcedural: true,
            limit: 20,
            minSimilarity: 0.2,
            maxAge: undefined, // No age restriction
            tags: undefined, // No tag filtering
          },
        );

        // Convert CoALA results to VectorSearchResult format
        // Note: Don't filter by source here - CoALA returns all relevant memories whether from vector or fallback search
        const vectorResults: VectorSearchResult[] = results.memories
          .map((memory: any) => ({
            id: memory.id,
            content: memory.content,
            timestamp: memory.timestamp,
            accessCount: memory.accessCount,
            lastAccessed: memory.lastAccessed,
            memoryType: memory.memoryType,
            relevanceScore: memory.relevanceScore,
            sourceScope: memory.sourceScope,
            associations: memory.associations,
            tags: memory.tags,
            confidence: memory.confidence,
            decayRate: memory.decayRate,
            similarity: memory.similarity || 0,
            matchedContent: typeof memory.content === "string"
              ? memory.content.substring(0, 200) + (memory.content.length > 200 ? "..." : "")
              : JSON.stringify(memory.content).substring(0, 200) + "...",
          }));

        // Sort by similarity score (highest first)
        return vectorResults.sort((a, b) => b.similarity - a.similarity);
      }

      console.warn("Vector search not available - CoALA manager not found");
      return [];
    } catch (error) {
      console.error("Vector search failed:", error);
      return [];
    }
  }

  exportToJson(): Promise<string> {
    return Promise.resolve(JSON.stringify(this.data, null, 2));
  }

  async importFromJson(jsonData: string): Promise<void> {
    try {
      const importedData = JSON.parse(jsonData);

      // Validate structure
      for (const memoryType of Object.values(CoALAMemoryType)) {
        if (!importedData[memoryType]) {
          importedData[memoryType] = {};
        }
      }

      // Convert date strings back to Date objects
      for (const [memoryType, entries] of Object.entries(importedData)) {
        for (const [key, entry] of Object.entries(entries)) {
          const typedEntry = entry;
          typedEntry.timestamp = new Date(typedEntry.timestamp);
          typedEntry.lastAccessed = new Date(typedEntry.lastAccessed);
        }
      }

      this.data = importedData;
    } catch (error) {
      throw new Error(
        `Failed to import JSON data: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get vector search statistics from the CoALA manager
   */
  async getVectorSearchStats(): Promise<unknown> {
    try {
      const loader = this.storage;
      if (loader.getCoALAManagerPublic) {
        const manager = await loader.getCoALAManagerPublic();
        return await manager.getVectorSearchStats();
      }
      return null;
    } catch (error) {
      console.error("Failed to get vector search stats:", error);
      return null;
    }
  }

  /**
   * Rebuild the vector search index for all indexed memory types
   */
  async rebuildVectorIndex(): Promise<void> {
    try {
      const loader = this.storage;
      if (loader.getCoALAManagerPublic) {
        const manager = await loader.getCoALAManagerPublic();
        await manager.rebuildVectorIndex();
        console.log("Vector index rebuild completed successfully");
      } else {
        console.warn("CoALA manager not available for vector index rebuild");
      }
    } catch (error) {
      console.error("Failed to rebuild vector index:", error);
      throw error;
    }
  }

  /**
   * Enhanced search that combines traditional and vector search for optimal results
   */
  async enhancedSearch(query: string, options?: {
    memoryTypes?: CoALAMemoryType[];
    limit?: number;
    minSimilarity?: number;
  }): Promise<Array<MemoryEntry & { similarity?: number; source: string }>> {
    const { memoryTypes, limit = 20, minSimilarity = 0.3 } = options || {};

    try {
      const loader = this.storage;
      if (loader.getCoALAManagerPublic) {
        const manager = await loader.getCoALAManagerPublic();

        // Use the CoALA manager's enhanced search for best results
        const results = await manager.getRelevantMemoriesForPrompt(query, {
          includeWorking: !memoryTypes || memoryTypes.includes(CoALAMemoryType.WORKING),
          includeEpisodic: !memoryTypes || memoryTypes.includes(CoALAMemoryType.EPISODIC),
          includeSemantic: !memoryTypes || memoryTypes.includes(CoALAMemoryType.SEMANTIC),
          includeProcedural: !memoryTypes || memoryTypes.includes(CoALAMemoryType.PROCEDURAL),
          limit,
          minSimilarity,
        });

        return results.memories.map((memory: any) => ({
          id: memory.id,
          content: memory.content,
          timestamp: memory.timestamp,
          accessCount: memory.accessCount,
          lastAccessed: memory.lastAccessed,
          memoryType: memory.memoryType,
          relevanceScore: memory.relevanceScore,
          sourceScope: memory.sourceScope,
          associations: memory.associations,
          tags: memory.tags,
          confidence: memory.confidence,
          decayRate: memory.decayRate,
          similarity: memory.similarity,
          source: memory.source,
        }));
      }

      // Fallback to traditional search across all specified types
      const results: Array<MemoryEntry & { similarity?: number; source: string }> = [];
      const typesToSearch = memoryTypes || Object.values(CoALAMemoryType);

      for (const type of typesToSearch) {
        const typeResults = await this.search(type, query);
        results.push(...typeResults.map((entry) => ({ ...entry, source: "traditional" })));
      }

      return results.slice(0, limit);
    } catch (error) {
      console.error("Enhanced search failed:", error);
      return [];
    }
  }
}

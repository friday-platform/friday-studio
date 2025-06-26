/**
 * Memory Operations
 *
 * Provides CRUD operations for memory entries
 */

import {
  type MemoryEntry,
  type MemoryOperations,
  type MemoryStorage,
  MemoryType,
  type VectorSearchResult,
} from "../types/memory-types.ts";
import { CoALAMemoryManager } from "../../../src/core/memory/coala-memory.ts";
import { CoALALocalFileStorageAdapter } from "../../../src/storage/coala-local.ts";
import { AtlasMemoryLoader } from "./memory-loader.ts";

export class AtlasMemoryOperations implements MemoryOperations {
  private storage: MemoryStorage;
  private data: Record<MemoryType, Record<string, MemoryEntry>> = {
    [MemoryType.WORKING]: {},
    [MemoryType.EPISODIC]: {},
    [MemoryType.SEMANTIC]: {},
    [MemoryType.PROCEDURAL]: {},
    [MemoryType.VECTOR_SEARCH]: {}, // Not used for storage, just for type compatibility
  };
  private coalaMemoryManager?: CoALAMemoryManager;

  constructor(storage: MemoryStorage) {
    this.storage = storage;
  }

  async initialize(): Promise<void> {
    this.data = await this.storage.loadAll();
  }

  create(
    type: MemoryType,
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

    this.data[type][key] = entry;
    return Promise.resolve();
  }

  read(type: MemoryType, key: string): Promise<MemoryEntry | null> {
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
    type: MemoryType,
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

  delete(type: MemoryType, key: string): Promise<void> {
    if (!this.data[type][key]) {
      throw new Error(`Memory entry '${key}' not found in ${type} memory`);
    }

    delete this.data[type][key];
    return Promise.resolve();
  }

  list(type: MemoryType): Promise<MemoryEntry[]> {
    return Promise.resolve(
      Object.values(this.data[type]).sort((a, b) =>
        b.lastAccessed.getTime() - a.lastAccessed.getTime()
      ),
    );
  }

  async search(type: MemoryType, query: string): Promise<MemoryEntry[]> {
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

  getAll(): Record<MemoryType, Record<string, MemoryEntry>> {
    return this.data;
  }

  getAllByType(type: MemoryType): Record<string, MemoryEntry> {
    return { ...this.data[type] };
  }

  getStats(): Record<MemoryType, {
    count: number;
    totalRelevance: number;
    avgRelevance: number;
    mostRecent?: Date;
    oldestEntry?: Date;
  }> {
    const stats: Record<MemoryType, {
      count: number;
      totalRelevance: number;
      avgRelevance: number;
      mostRecent?: Date;
      oldestEntry?: Date;
    }> = {
      [MemoryType.WORKING]: { count: 0, totalRelevance: 0, avgRelevance: 0 },
      [MemoryType.EPISODIC]: { count: 0, totalRelevance: 0, avgRelevance: 0 },
      [MemoryType.SEMANTIC]: { count: 0, totalRelevance: 0, avgRelevance: 0 },
      [MemoryType.PROCEDURAL]: { count: 0, totalRelevance: 0, avgRelevance: 0 },
      [MemoryType.VECTOR_SEARCH]: {
        count: 0,
        totalRelevance: 0,
        avgRelevance: 0,
      },
    };

    for (const [memoryType, entries] of Object.entries(this.data)) {
      const entryValues = Object.values(entries);
      const timestamps = entryValues.map((e) => e.timestamp);

      stats[memoryType as MemoryType] = {
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
    // Initialize CoALA memory manager if not already done
    if (!this.coalaMemoryManager) {
      const mockScope = {
        id: "memory-manager-scope",
      } as any;

      // Get the storage path from the AtlasMemoryLoader
      let storagePath: string;
      if (this.storage instanceof AtlasMemoryLoader) {
        // Access the private storagePath through the public getStorageStats method
        const stats = await this.storage.getStorageStats();
        storagePath = stats.path;
      } else {
        // Fallback to default path
        storagePath = "./.atlas/memory";
      }

      // Create CoALA storage adapter with the correct path
      const coalaStorage = new CoALALocalFileStorageAdapter(storagePath);

      this.coalaMemoryManager = new CoALAMemoryManager(
        mockScope,
        coalaStorage, // Use workspace-specific storage
        false, // Disable cognitive loop
        {
          autoIndexOnWrite: true,
          batchSize: 10,
          similarityThreshold: 0.3,
        },
      );
    }

    try {
      // Perform vector search across all indexed memory types
      const results = await this.coalaMemoryManager
        .getRelevantMemoriesForPrompt(
          query,
          {
            includeWorking: false, // WORKING memory doesn't use vector search
            includeEpisodic: true,
            includeSemantic: true,
            includeProcedural: true,
            limit: 20,
            minSimilarity: 0.2,
            contextFormat: "detailed",
          },
        );

      // Convert CoALA results to VectorSearchResult format
      const vectorResults: VectorSearchResult[] = results.memories.map((
        memory,
      ) => ({
        id: memory.id,
        content: memory.content,
        timestamp: memory.timestamp,
        accessCount: memory.accessCount,
        lastAccessed: memory.lastAccessed,
        memoryType: memory.memoryType as unknown as MemoryType, // Convert CoALA type to MemoryType
        relevanceScore: memory.relevanceScore,
        sourceScope: memory.sourceScope,
        associations: memory.associations,
        tags: memory.tags,
        confidence: memory.confidence,
        decayRate: memory.decayRate,
        similarity: memory.similarity || 0,
        matchedContent: typeof memory.content === "string"
          ? memory.content.substring(0, 200) + "..."
          : JSON.stringify(memory.content).substring(0, 200) + "...",
      }));

      // If vector search returns no results, fall back to traditional text search
      if (vectorResults.length === 0) {
        console.log(
          "Vector search returned no results, falling back to text search...",
        );
        const fallbackResults: VectorSearchResult[] = [];

        // Search across semantic, episodic, and procedural memory types
        for (
          const memoryType of [
            MemoryType.SEMANTIC,
            MemoryType.EPISODIC,
            MemoryType.PROCEDURAL,
          ]
        ) {
          const textResults = await this.search(memoryType, query);

          // Convert text search results to VectorSearchResult format
          for (const memory of textResults.slice(0, 7)) { // Limit per type
            fallbackResults.push({
              ...memory,
              similarity: 0.5, // Assign moderate similarity for text matches
              matchedContent: typeof memory.content === "string"
                ? memory.content.substring(0, 200) + "..."
                : JSON.stringify(memory.content).substring(0, 200) + "...",
            });
          }
        }

        // Sort by relevance score since we don't have real similarity scores
        return fallbackResults.sort((a, b) =>
          b.relevanceScore - a.relevanceScore
        );
      }

      // Sort by similarity score (highest first)
      return vectorResults.sort((a, b) => b.similarity - a.similarity);
    } catch (error) {
      console.error("Vector search failed:", error);

      // Fall back to traditional text search on error
      console.log("Falling back to text search due to error...");
      const fallbackResults: VectorSearchResult[] = [];

      try {
        // Search across semantic, episodic, and procedural memory types
        for (
          const memoryType of [
            MemoryType.SEMANTIC,
            MemoryType.EPISODIC,
            MemoryType.PROCEDURAL,
          ]
        ) {
          const textResults = await this.search(memoryType, query);

          // Convert text search results to VectorSearchResult format
          for (const memory of textResults.slice(0, 7)) { // Limit per type
            fallbackResults.push({
              ...memory,
              similarity: 0.5, // Assign moderate similarity for text matches
              matchedContent: typeof memory.content === "string"
                ? memory.content.substring(0, 200) + "..."
                : JSON.stringify(memory.content).substring(0, 200) + "...",
            });
          }
        }

        // Sort by relevance score since we don't have real similarity scores
        return fallbackResults.sort((a, b) =>
          b.relevanceScore - a.relevanceScore
        );
      } catch (fallbackError) {
        console.error("Text search fallback also failed:", fallbackError);
        return [];
      }
    }
  }

  exportToJson(): Promise<string> {
    return Promise.resolve(JSON.stringify(this.data, null, 2));
  }

  async importFromJson(jsonData: string): Promise<void> {
    try {
      const importedData = JSON.parse(jsonData);

      // Validate structure
      for (const memoryType of Object.values(MemoryType)) {
        if (!importedData[memoryType]) {
          importedData[memoryType] = {};
        }
      }

      // Convert date strings back to Date objects
      for (const [memoryType, entries] of Object.entries(importedData)) {
        for (const [key, entry] of Object.entries(entries as any)) {
          const typedEntry = entry as any;
          typedEntry.timestamp = new Date(typedEntry.timestamp);
          typedEntry.lastAccessed = new Date(typedEntry.lastAccessed);
        }
      }

      this.data = importedData;
    } catch (error) {
      throw new Error(
        `Failed to import JSON data: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * Memory Loader
 *
 * Loads and saves memory data from Atlas workspace memory files using the current MECMF system
 */

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { CoALAMemoryType, type MemoryEntry, type MemoryStorage } from "../types/memory-types.ts";
import { CoALAMemoryManager } from "@atlas/memory";
import { WebEmbeddingProvider } from "../../../packages/memory/src/web-embedding-provider.ts";
import { getWorkspaceMemoryDir } from "../../../src/utils/paths.ts";

export class AtlasMemoryLoader implements MemoryStorage {
  private workspacePath: string;
  private workspaceId: string;
  private coalaManager?: CoALAMemoryManager;
  private embeddingProvider?: WebEmbeddingProvider;

  constructor(workspacePath?: string, workspaceId?: string) {
    this.workspacePath = workspacePath || Deno.cwd();
    // Use provided workspace ID, or derive from path as fallback
    if (workspaceId) {
      this.workspaceId = workspaceId;
    } else {
      this.workspaceId = this.workspacePath.split("/").pop() || "default-workspace";
    }
  }

  private async getCoALAManager(): Promise<CoALAMemoryManager> {
    if (!this.coalaManager) {
      // Initialize the WebEmbeddingProvider
      if (!this.embeddingProvider) {
        this.embeddingProvider = new WebEmbeddingProvider({
          model: "sentence-transformers/all-MiniLM-L6-v2",
          backend: "onnxruntime-node",
          batchSize: 10,
          maxSequenceLength: 512,
          cacheDirectory: getWorkspaceMemoryDir(this.workspaceId),
        });

        // Warm up the embedding provider
        try {
          await this.embeddingProvider.warmup();
        } catch (error) {
          console.warn("Failed to warm up embedding provider:", error);
        }
      }

      // Create a proper scope for the memory manager
      const scope = {
        id: this.workspaceId,
        workspaceId: this.workspaceId,
        type: "workspace" as const,
      } as any;

      // Create CoALA manager with vector search enabled
      this.coalaManager = new CoALAMemoryManager(scope, undefined, true);

      // Initialize vector search capabilities using the WebEmbeddingProvider
      try {
        await this.coalaManager.initializeVectorSearch({
          embeddingProvider: this.embeddingProvider,
          dimension: 384, // all-MiniLM-L6-v2 produces 384-dimensional embeddings
          similarityThreshold: 0.3,
          batchSize: 10,
          autoIndexOnWrite: true,
        });
      } catch (error) {
        console.warn("Failed to initialize vector search, continuing without it:", error);
      }

      // Load existing memories from storage
      try {
        await this.coalaManager.loadFromStorage();
      } catch (error) {
        console.warn("Failed to load existing memories from storage:", error);
      }
    }
    return this.coalaManager;
  }

  async loadAll(): Promise<Record<CoALAMemoryType, Record<string, MemoryEntry>>> {
    const manager = await this.getCoALAManager();
    const result: Record<CoALAMemoryType, Record<string, MemoryEntry>> = {
      [CoALAMemoryType.WORKING]: {},
      [CoALAMemoryType.EPISODIC]: {},
      [CoALAMemoryType.SEMANTIC]: {},
      [CoALAMemoryType.PROCEDURAL]: {},
      [CoALAMemoryType.CONTEXTUAL]: {},
    };

    for (const memoryType of Object.values(CoALAMemoryType)) {
      try {
        result[memoryType] = await this.loadByType(memoryType);
      } catch (error) {
        console.warn(`Failed to load ${memoryType} memory:`, error);
        result[memoryType] = {};
      }
    }

    return result;
  }

  async saveAll(
    data: Record<CoALAMemoryType, Record<string, MemoryEntry>>,
  ): Promise<void> {
    const manager = await this.getCoALAManager();

    // Use the CoALA manager to save data
    for (const [memoryType, entries] of Object.entries(data)) {
      for (const [key, entry] of Object.entries(entries)) {
        try {
          await manager.remember(key, entry.content, {
            memoryType: memoryType as CoALAMemoryType,
            relevanceScore: entry.relevanceScore,
            sourceScope: entry.sourceScope,
            tags: entry.tags,
            confidence: entry.confidence,
            decayRate: entry.decayRate,
            associations: entry.associations,
          });
        } catch (error) {
          console.warn(`Failed to save memory ${key}:`, error);
        }
      }
    }

    // Force a commit to storage
    await manager.commitToStorage();
  }

  async loadByType(type: CoALAMemoryType): Promise<Record<string, MemoryEntry>> {
    const manager = await this.getCoALAManager();

    try {
      // Get memories by type using the CoALA interface
      const memories = manager.getMemoriesByType(type);

      const entries: Record<string, MemoryEntry> = {};

      for (const memory of memories) {
        // Ensure proper MemoryEntry structure with all required fields
        entries[memory.id] = {
          id: memory.id,
          content: memory.content,
          timestamp: memory.timestamp,
          accessCount: memory.accessCount || 0,
          lastAccessed: memory.lastAccessed,
          memoryType: memory.memoryType,
          relevanceScore: memory.relevanceScore,
          sourceScope: memory.sourceScope,
          associations: memory.associations || [],
          tags: memory.tags || [],
          confidence: memory.confidence,
          decayRate: memory.decayRate,
        } as MemoryEntry;
      }

      return entries;
    } catch (error) {
      console.warn(`Failed to load ${type} memories from CoALA manager:`, error);
      return {};
    }
  }

  async saveByType(
    type: CoALAMemoryType,
    data: Record<string, MemoryEntry>,
  ): Promise<void> {
    const manager = await this.getCoALAManager();

    // Save each memory entry using the CoALA manager
    for (const [key, entry] of Object.entries(data)) {
      try {
        await manager.remember(key, entry.content, {
          memoryType: type,
          relevanceScore: entry.relevanceScore,
          sourceScope: entry.sourceScope,
          tags: entry.tags,
          confidence: entry.confidence,
          decayRate: entry.decayRate,
          associations: entry.associations,
        });
      } catch (error) {
        console.warn(`Failed to save memory ${key} of type ${type}:`, error);
      }
    }

    // Force a commit to storage
    await manager.commitToStorage();
  }

  async getStorageStats(): Promise<{
    path: string;
    memoryTypes: Record<
      CoALAMemoryType,
      { count: number; lastModified?: Date; size?: number }
    >;
  }> {
    const manager = await this.getCoALAManager();
    const stats: Record<
      CoALAMemoryType,
      { count: number; lastModified?: Date; size?: number }
    > = {
      [CoALAMemoryType.WORKING]: { count: 0 },
      [CoALAMemoryType.EPISODIC]: { count: 0 },
      [CoALAMemoryType.SEMANTIC]: { count: 0 },
      [CoALAMemoryType.PROCEDURAL]: { count: 0 },
      [CoALAMemoryType.CONTEXTUAL]: { count: 0 },
    };

    for (const memoryType of Object.values(CoALAMemoryType)) {
      try {
        const data = await this.loadByType(memoryType);
        const entries = Object.values(data);

        stats[memoryType] = {
          count: entries.length,
          lastModified: entries.length > 0
            ? new Date(Math.max(...entries.map((e) => e.lastAccessed.getTime())))
            : undefined,
          size: undefined, // Size calculation would require accessing file system directly
        };
      } catch {
        stats[memoryType] = { count: 0 };
      }
    }

    // Get the actual storage path from the workspace memory directory
    const storagePath = getWorkspaceMemoryDir(this.workspaceId);

    return {
      path: storagePath,
      memoryTypes: stats,
    };
  }

  // Public method to access the CoALA manager for vector search
  async getCoALAManagerPublic(): Promise<CoALAMemoryManager> {
    return await this.getCoALAManager();
  }

  // Cleanup method to dispose of resources
  async dispose(): Promise<void> {
    if (this.embeddingProvider) {
      await this.embeddingProvider.dispose();
      this.embeddingProvider = undefined;
    }
    this.coalaManager = undefined;
  }
}

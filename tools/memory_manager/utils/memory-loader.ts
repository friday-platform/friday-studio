/**
 * Memory Loader
 *
 * Loads and saves memory data from Atlas workspace memory files using the current MECMF system
 */

import { CoALAMemoryManager, MEMORY_TYPES } from "@atlas/memory";
import type { IMemoryScope } from "../../../packages/memory/src/coala-memory.ts";
import { getWorkspaceMemoryDir } from "../../../src/utils/paths.ts";
import type { CoALAMemoryType, MemoryEntry, MemoryStorage } from "../types/memory-types.ts";

export class AtlasMemoryLoader implements MemoryStorage {
  private workspacePath: string;
  private workspaceId: string;
  private coalaManager?: CoALAMemoryManager;

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
      // Create a proper scope for the memory manager
      const scope: IMemoryScope = { id: this.workspaceId, workspaceId: this.workspaceId };

      // Create CoALA manager with vector search enabled
      this.coalaManager = new CoALAMemoryManager(scope, undefined, true);

      // Initialize vector search capabilities
      try {
        await this.coalaManager.initializeVectorSearch({
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
    await this.getCoALAManager();
    const result: Record<CoALAMemoryType, Record<string, MemoryEntry>> = {
      working: {},
      episodic: {},
      semantic: {},
      procedural: {},
      contextual: {},
    };

    for (const memoryType of MEMORY_TYPES) {
      try {
        result[memoryType] = await this.loadByType(memoryType);
      } catch (error) {
        console.warn(`Failed to load ${memoryType} memory:`, error);
        result[memoryType] = {};
      }
    }

    return result;
  }

  saveAll(_: Record<CoALAMemoryType, Record<string, MemoryEntry>>): Promise<void> {
    console.log("Memory manager does not support saving all memories");
    return Promise.resolve();
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
        };
      }

      return entries;
    } catch (error) {
      console.warn(`Failed to load ${type} memories from CoALA manager:`, error);
      return {};
    }
  }

  saveByType(_: CoALAMemoryType, __: Record<string, MemoryEntry>): Promise<void> {
    console.log("Memory manager does not support saving memories by type");
    return Promise.resolve();
  }

  async getStorageStats(): Promise<{
    path: string;
    memoryTypes: Record<CoALAMemoryType, { count: number; lastModified?: Date; size?: number }>;
  }> {
    await this.getCoALAManager();
    const stats: Record<CoALAMemoryType, { count: number; lastModified?: Date; size?: number }> = {
      working: { count: 0 },
      episodic: { count: 0 },
      semantic: { count: 0 },
      procedural: { count: 0 },
      contextual: { count: 0 },
    };

    for (const memoryType of MEMORY_TYPES) {
      try {
        const data = await this.loadByType(memoryType);
        const entries = Object.values(data);

        stats[memoryType] = {
          count: entries.length,
          lastModified:
            entries.length > 0
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

    return { path: storagePath, memoryTypes: stats };
  }

  // Public method to access the CoALA manager for vector search
  async getCoALAManagerPublic(): Promise<CoALAMemoryManager> {
    return await this.getCoALAManager();
  }

  // Cleanup method to dispose of resources
  dispose(): void {
    this.coalaManager = undefined;
  }
}

/**
 * Memory Loader
 *
 * Loads and saves memory data from Atlas workspace memory files
 */

import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import { type MemoryEntry, type MemoryStorage, MemoryType } from "../types/memory-types.ts";

export class AtlasMemoryLoader implements MemoryStorage {
  private storagePath: string;
  private memoryTypeFiles: Record<MemoryType, string> = {
    [MemoryType.WORKING]: "working.json",
    [MemoryType.EPISODIC]: "episodic.json",
    [MemoryType.SEMANTIC]: "semantic.json",
    [MemoryType.PROCEDURAL]: "procedural.json",
    [MemoryType.VECTOR_SEARCH]: "vector_search.json", // Not used for storage but needed for completeness
  };

  constructor(workspacePath?: string) {
    this.storagePath = workspacePath
      ? join(workspacePath, ".atlas", "memory")
      : join(Deno.cwd(), ".atlas", "memory");
  }

  async loadAll(): Promise<Record<MemoryType, Record<string, MemoryEntry>>> {
    const result: Record<MemoryType, Record<string, MemoryEntry>> = {
      [MemoryType.WORKING]: {},
      [MemoryType.EPISODIC]: {},
      [MemoryType.SEMANTIC]: {},
      [MemoryType.PROCEDURAL]: {},
      [MemoryType.VECTOR_SEARCH]: {}, // Not used for storage but needed for completeness
    };

    for (const memoryType of Object.values(MemoryType)) {
      // Skip vector search as it's not persisted to disk
      if (memoryType === MemoryType.VECTOR_SEARCH) {
        result[memoryType] = {};
        continue;
      }
      
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
    data: Record<MemoryType, Record<string, MemoryEntry>>,
  ): Promise<void> {
    await ensureDir(this.storagePath);

    const savePromises = Object.entries(data).map(([memoryType, entries]) =>
      this.saveByType(memoryType as MemoryType, entries)
    );

    await Promise.all(savePromises);
  }

  async loadByType(type: MemoryType): Promise<Record<string, MemoryEntry>> {
    const fileName = this.memoryTypeFiles[type];
    const filePath = join(this.storagePath, fileName);

    try {
      const content = await Deno.readTextFile(filePath);

      if (!content.trim()) {
        return {};
      }

      const rawData = JSON.parse(content);
      const entries: Record<string, MemoryEntry> = {};

      // Convert raw data to MemoryEntry objects
      for (const [key, rawEntry] of Object.entries(rawData)) {
        const entry = rawEntry as Record<string, unknown>;
        entries[key] = {
          id: key,
          content: entry.content,
          timestamp: new Date(entry.timestamp),
          accessCount: entry.accessCount || 0,
          lastAccessed: new Date(entry.lastAccessed || entry.timestamp),
          memoryType: type,
          relevanceScore: entry.relevanceScore || 0.5,
          sourceScope: entry.sourceScope || "unknown",
          associations: entry.associations || [],
          tags: entry.tags || [],
          confidence: entry.confidence || 1.0,
          decayRate: entry.decayRate || 0.1,
        };
      }

      return entries;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return {};
      }

      if (error instanceof SyntaxError) {
        console.warn(`Failed to parse JSON in ${filePath}: ${error.message}`);
        return {};
      }

      throw error;
    }
  }

  async saveByType(
    type: MemoryType,
    data: Record<string, MemoryEntry>,
  ): Promise<void> {
    await ensureDir(this.storagePath);

    const fileName = this.memoryTypeFiles[type];
    const filePath = join(this.storagePath, fileName);

    // Convert MemoryEntry objects to serializable format
    const serializable: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(data)) {
      serializable[key] = {
        ...entry,
        timestamp: entry.timestamp.toISOString(),
        lastAccessed: entry.lastAccessed.toISOString(),
      };
    }

    await Deno.writeTextFile(filePath, JSON.stringify(serializable, null, 2));
  }

  async getStorageStats(): Promise<{
    path: string;
    memoryTypes: Record<
      MemoryType,
      { count: number; lastModified?: Date; size?: number }
    >;
  }> {
    const stats: Record<
      MemoryType,
      { count: number; lastModified?: Date; size?: number }
    > = {
      [MemoryType.WORKING]: { count: 0 },
      [MemoryType.EPISODIC]: { count: 0 },
      [MemoryType.SEMANTIC]: { count: 0 },
      [MemoryType.PROCEDURAL]: { count: 0 },
      [MemoryType.VECTOR_SEARCH]: { count: 0 },
    };

    for (const memoryType of Object.values(MemoryType)) {
      // Skip vector search as it's not persisted to disk
      if (memoryType === MemoryType.VECTOR_SEARCH) {
        stats[memoryType] = { count: 0 };
        continue;
      }
      
      const fileName = this.memoryTypeFiles[memoryType];
      const filePath = join(this.storagePath, fileName);

      try {
        const fileInfo = await Deno.stat(filePath);
        const data = await this.loadByType(memoryType);

        stats[memoryType] = {
          count: Object.keys(data).length,
          lastModified: fileInfo.mtime || undefined,
          size: fileInfo.size,
        };
      } catch {
        // File doesn't exist or can't be read
        stats[memoryType] = { count: 0 };
      }
    }

    return {
      path: this.storagePath,
      memoryTypes: stats,
    };
  }
}

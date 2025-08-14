/**
 * Direct File Memory Loader
 *
 * Bypasses the CoALA manager and reads memory files directly
 */

import { join } from "@std/path";
import { CoALAMemoryType, type MemoryEntry, type MemoryStorage } from "../types/memory-types.ts";
import { getWorkspaceMemoryDir } from "../../../src/utils/paths.ts";

export class DirectFileMemoryLoader implements MemoryStorage {
  private workspaceId: string;

  constructor(workspaceId: string) {
    this.workspaceId = workspaceId;
  }

  async loadAll(): Promise<Record<CoALAMemoryType, Record<string, MemoryEntry>>> {
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
    // Not implemented for direct file approach
    throw new Error("Direct file saving not implemented");
  }

  async loadByType(type: CoALAMemoryType): Promise<Record<string, MemoryEntry>> {
    const memoryDir = getWorkspaceMemoryDir(this.workspaceId);

    // Map CoALA types to file names
    const fileMap: Record<CoALAMemoryType, string> = {
      [CoALAMemoryType.WORKING]: "working.json",
      [CoALAMemoryType.EPISODIC]: "episodic.json",
      [CoALAMemoryType.SEMANTIC]: "semantic.json",
      [CoALAMemoryType.PROCEDURAL]: "procedural.json",
      [CoALAMemoryType.CONTEXTUAL]: "contextual.json",
    };

    const filePath = join(memoryDir, fileMap[type]);

    try {
      const fileContent = await Deno.readTextFile(filePath);
      const data = JSON.parse(fileContent);

      // Convert the raw data to MemoryEntry format
      const entries: Record<string, MemoryEntry> = {};

      for (const [key, rawEntry] of Object.entries(data)) {
        const entry = rawEntry as any;
        entries[key] = {
          id: entry.id || key,
          content: entry.content,
          timestamp: new Date(entry.timestamp),
          accessCount: entry.accessCount || 0,
          lastAccessed: new Date(entry.lastAccessed || entry.timestamp),
          memoryType: entry.memoryType || type,
          relevanceScore: entry.relevanceScore || 1,
          sourceScope: entry.sourceScope || this.workspaceId,
          associations: entry.associations || [],
          tags: entry.tags || [],
          confidence: entry.confidence || 1,
          decayRate: entry.decayRate || 0.1,
        };
      }

      return entries;
    } catch (error) {
      // File doesn't exist or can't be read
      if (error instanceof Deno.errors.NotFound) {
        return {};
      }
      throw error;
    }
  }

  async saveByType(
    type: CoALAMemoryType,
    data: Record<string, MemoryEntry>,
  ): Promise<void> {
    // Not implemented for direct file approach
    throw new Error("Direct file saving not implemented");
  }

  async getStorageStats(): Promise<{
    path: string;
    memoryTypes: Record<
      CoALAMemoryType,
      { count: number; lastModified?: Date; size?: number }
    >;
  }> {
    const memoryDir = getWorkspaceMemoryDir(this.workspaceId);
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
        };
      } catch {
        stats[memoryType] = { count: 0 };
      }
    }

    return {
      path: memoryDir,
      memoryTypes: stats,
    };
  }
}

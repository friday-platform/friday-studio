/**
 * CoALA Multi-File Local Storage Adapter
 *
 * Stores different memory types in separate files for better organization:
 * - working.json - Short-term working memory
 * - episodic.json - Specific experiences and events
 * - semantic.json - General knowledge and concepts
 * - procedural.json - How-to knowledge and skills
 * - contextual.json - Session/agent specific context
 */

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { getAtlasHome } from "../../../../src/utils/paths.ts";
import type { ICoALAMemoryStorageAdapter } from "../types/core.ts";
import { FileWriteCoordinator } from "./file-write-coordinator.ts";

export class CoALALocalFileStorageAdapter implements ICoALAMemoryStorageAdapter {
  private storagePath: string;
  private memoryTypeFiles: Record<string, string> = {
    working: "working.json",
    episodic: "episodic.json",
    semantic: "semantic.json",
    procedural: "procedural.json",
    contextual: "contextual.json",
  };

  constructor(storagePath?: string) {
    if (storagePath) {
      this.storagePath = storagePath;
    } else {
      // Use the centralized getAtlasHome function
      this.storagePath = join(getAtlasHome(), "memory");
    }
  }

  // Legacy compatibility methods
  async commit(data: any): Promise<void> {
    // For backwards compatibility, organize data by memory type
    const dataByType: Record<string, any> = {};

    for (const [key, memory] of Object.entries(data)) {
      const memoryType = memory.memoryType || "working";
      if (!dataByType[memoryType]) {
        dataByType[memoryType] = {};
      }
      dataByType[memoryType][key] = memory;
    }

    await this.commitAll(dataByType);
  }

  async load(): Promise<any> {
    const allData = await this.loadAll();
    const combinedData: any = {};

    // Combine all memory types into single object for backwards compatibility
    for (const typeData of Object.values(allData)) {
      Object.assign(combinedData, typeData);
    }

    return combinedData;
  }

  // Enhanced CoALA-specific methods
  async commitByType(memoryType: string, data: any): Promise<void> {
    await ensureDir(this.storagePath);
    const fileName = this.memoryTypeFiles[memoryType] || `${memoryType}.json`;
    const filePath = join(this.storagePath, fileName);

    // Use the file write coordinator to prevent concurrent writes
    const coordinator = FileWriteCoordinator.getInstance();
    await coordinator.executeWrite(filePath, async () => {
      await Deno.writeTextFile(filePath, JSON.stringify(data, null, 2));
    });
  }

  async loadByType(memoryType: string): Promise<any> {
    const fileName = this.memoryTypeFiles[memoryType] || `${memoryType}.json`;
    const filePath = join(this.storagePath, fileName);

    try {
      const content = await Deno.readTextFile(filePath);

      // Handle empty or whitespace-only files
      if (!content.trim()) {
        return {};
      }

      return JSON.parse(content);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return {};
      }

      // Handle JSON parsing errors gracefully
      if (error instanceof SyntaxError) {
        console.warn(
          `Failed to parse JSON in ${filePath}: ${error.message}. Returning empty object.`,
        );
        return {};
      }

      throw error;
    }
  }

  async commitAll(dataByType: Record<string, any>): Promise<void> {
    await ensureDir(this.storagePath);

    // Write each memory type to its own file sequentially to avoid file descriptor exhaustion
    for (const [memoryType, data] of Object.entries(dataByType)) {
      if (data && Object.keys(data).length > 0) {
        await this.commitByType(memoryType, data);
      }
    }

    // Create an index file for quick overview
    await this.createIndexFile(dataByType);
  }

  async loadAll(): Promise<Record<string, any>> {
    const allData: Record<string, any> = {};

    // Load all known memory types
    const loadPromises = Object.keys(this.memoryTypeFiles).map(async (memoryType) => {
      const data = await this.loadByType(memoryType);
      if (data && Object.keys(data).length > 0) {
        allData[memoryType] = data;
      }
    });

    await Promise.all(loadPromises);

    // Also check for any additional memory type files
    try {
      const additionalTypes = await this.loadAdditionalMemoryTypes();
      for (const memoryType of additionalTypes) {
        if (!allData[memoryType]) {
          const data = await this.loadByType(memoryType);
          if (data && Object.keys(data).length > 0) {
            allData[memoryType] = data;
          }
        }
      }
    } catch {
      // Ignore errors when scanning for additional files
    }

    return allData;
  }

  async listMemoryTypes(): Promise<string[]> {
    const types = new Set<string>();

    // Add known types
    Object.keys(this.memoryTypeFiles).forEach((type) => types.add(type));

    // Scan directory for additional memory type files
    try {
      for await (const dirEntry of Deno.readDir(this.storagePath)) {
        if (dirEntry.isFile && dirEntry.name.endsWith(".json") && dirEntry.name !== "index.json") {
          const memoryType = dirEntry.name.replace(".json", "");
          types.add(memoryType);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        console.warn("Error scanning memory directory:", error);
      }
    }

    return Array.from(types);
  }

  // Helper methods
  private async createIndexFile(dataByType: Record<string, any>): Promise<void> {
    const index = { lastUpdated: new Date().toISOString(), memoryTypes: {} as Record<string, any> };

    for (const [memoryType, data] of Object.entries(dataByType)) {
      if (data && typeof data === "object") {
        const entries = Object.values(data);
        index.memoryTypes[memoryType] = {
          count: entries.length,
          latestTimestamp: this.getLatestTimestamp(entries),
          avgRelevance: this.getAverageRelevance(entries),
          fileName: this.memoryTypeFiles[memoryType] || `${memoryType}.json`,
        };
      }
    }

    const indexPath = join(this.storagePath, "index.json");

    // Use the file write coordinator to prevent concurrent writes to index.json
    const coordinator = FileWriteCoordinator.getInstance();
    await coordinator.executeWrite(indexPath, async () => {
      await Deno.writeTextFile(indexPath, JSON.stringify(index, null, 2));
    });
  }

  private async loadAdditionalMemoryTypes(): Promise<string[]> {
    const additionalTypes: string[] = [];

    try {
      for await (const dirEntry of Deno.readDir(this.storagePath)) {
        if (dirEntry.isFile && dirEntry.name.endsWith(".json") && dirEntry.name !== "index.json") {
          const memoryType = dirEntry.name.replace(".json", "");
          if (!this.memoryTypeFiles[memoryType]) {
            additionalTypes.push(memoryType);
          }
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }

    return additionalTypes;
  }

  private getLatestTimestamp(entries: any[]): string | null {
    if (!entries.length) return null;

    const timestamps = entries
      .map((entry) => entry.timestamp || entry.lastAccessed)
      .filter((ts) => ts)
      .map((ts) => (typeof ts === "string" ? ts : ts.toISOString()))
      .sort()
      .reverse();

    return timestamps[0] || null;
  }

  private getAverageRelevance(entries: any[]): number {
    if (!entries.length) return 0;

    const relevanceScores = entries
      .map((entry) => entry.relevanceScore)
      .filter((score) => typeof score === "number");

    if (!relevanceScores.length) return 0;

    return relevanceScores.reduce((sum, score) => sum + score, 0) / relevanceScores.length;
  }

  // Utility methods for memory management
  async getMemoryStatistics(): Promise<Record<string, any>> {
    try {
      const indexPath = join(this.storagePath, "index.json");
      const content = await Deno.readTextFile(indexPath);
      return JSON.parse(content);
    } catch {
      // If index doesn't exist, generate statistics on the fly
      const allData = await this.loadAll();
      const stats: Record<string, any> = {};

      for (const [memoryType, data] of Object.entries(allData)) {
        const entries = Object.values(data);
        stats[memoryType] = {
          count: entries.length,
          latestTimestamp: this.getLatestTimestamp(entries),
          avgRelevance: this.getAverageRelevance(entries),
        };
      }

      return { lastUpdated: new Date().toISOString(), memoryTypes: stats };
    }
  }

  async compactMemoryType(memoryType: string): Promise<void> {
    // Load memories of this type
    const data = await this.loadByType(memoryType);

    if (!data || Object.keys(data).length === 0) {
      return;
    }

    // Filter out memories with very low relevance (< 0.1)
    const filteredData: any = {};
    let removedCount = 0;

    for (const [key, memory] of Object.entries(data)) {
      const memoryObj = memory;
      if (memoryObj.relevanceScore >= 0.1) {
        filteredData[key] = memory;
      } else {
        removedCount++;
      }
    }

    if (removedCount > 0) {
      await this.commitByType(memoryType, filteredData);
      console.log(`Compacted ${memoryType} memory: removed ${removedCount} low-relevance entries`);
    }
  }

  async compactAllMemoryTypes(): Promise<void> {
    const memoryTypes = await this.listMemoryTypes();
    // Compact memory types sequentially to avoid file descriptor exhaustion
    for (const type of memoryTypes) {
      await this.compactMemoryType(type);
    }
  }
}

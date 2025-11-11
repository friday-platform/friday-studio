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

import type { CoALAMemoryEntry } from "@atlas/memory";
import { CoALAMemoryEntrySchema, type CoALAMemoryType } from "@atlas/memory";
import { isErrnoException, objectKeys } from "@atlas/utils";
import { z } from "zod";

// Zod schema for memory statistics/index structure
const MemoryTypeStatSchema = z.object({
  count: z.number(),
  latestTimestamp: z.string().nullable(),
  avgRelevance: z.number(),
  fileName: z.string(),
});

const MemoryStatisticsSchema = z.object({
  lastUpdated: z.string(),
  memoryTypes: z.record(z.string(), MemoryTypeStatSchema),
});

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAtlasHome } from "@atlas/utils/paths.server";
import type { ICoALAMemoryStorageAdapter } from "../types/core.ts";
import { FileWriteCoordinator } from "./file-write-coordinator.ts";

export class CoALALocalFileStorageAdapter implements ICoALAMemoryStorageAdapter {
  private storagePath: string;
  private memoryTypeFiles: Record<CoALAMemoryType, string> = {
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

  // Enhanced CoALA-specific methods
  async commitByType(memoryType: CoALAMemoryType, data: CoALAMemoryEntry[]): Promise<void> {
    await mkdir(this.storagePath, { recursive: true });
    const fileName = this.memoryTypeFiles[memoryType] || `${memoryType}.json`;
    const filePath = join(this.storagePath, fileName);

    // Use the file write coordinator to prevent concurrent writes
    const coordinator = FileWriteCoordinator.getInstance();
    await coordinator.executeWrite(filePath, async () => {
      await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
    });
  }

  async loadByType(memoryType: CoALAMemoryType): Promise<CoALAMemoryEntry[]> {
    const fileName = this.memoryTypeFiles[memoryType] || `${memoryType}.json`;
    const filePath = join(this.storagePath, fileName);

    try {
      const content = await readFile(filePath, "utf-8");

      // Handle empty or whitespace-only files
      if (!content.trim()) {
        return [];
      }

      // Parse and validate using Zod schema
      const MemoryArraySchema = z.array(CoALAMemoryEntrySchema);
      const rawData = JSON.parse(content);
      const validatedData = MemoryArraySchema.parse(rawData);

      return validatedData;
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        return [];
      }

      // Handle JSON parsing errors gracefully
      if (error instanceof SyntaxError) {
        console.warn(
          `Failed to parse JSON in ${filePath}: ${error.message}. Returning empty array.`,
        );
        return [];
      }

      // Handle Zod validation errors gracefully
      if (error instanceof z.ZodError) {
        console.warn(
          `Failed to validate memory data structure in ${filePath}: ${error.message}. Returning empty array.`,
        );
        return [];
      }

      throw error;
    }
  }

  async commitAll(dataByType: Record<CoALAMemoryType, CoALAMemoryEntry[]>): Promise<void> {
    await mkdir(this.storagePath, { recursive: true });

    // Write each memory type to its own file sequentially to avoid file descriptor exhaustion
    for (const memoryType of objectKeys(dataByType)) {
      const data = dataByType[memoryType];
      if (data) {
        await this.commitByType(memoryType, data);
      }
    }

    // Create an index file for quick overview
    await this.createIndexFile(dataByType);
  }

  async loadAll(): Promise<Record<CoALAMemoryType, CoALAMemoryEntry[]>> {
    const allData: Record<CoALAMemoryType, CoALAMemoryEntry[]> = {
      working: [],
      episodic: [],
      semantic: [],
      procedural: [],
      contextual: [],
    };

    // Load all known memory types
    const loadPromises = objectKeys(this.memoryTypeFiles).map(async (memoryType) => {
      const data = await this.loadByType(memoryType);
      if (data && data.length > 0) {
        allData[memoryType] = data;
      }
    });

    await Promise.all(loadPromises);

    return allData;
  }

  listMemoryTypes(): CoALAMemoryType[] {
    return objectKeys(this.memoryTypeFiles);
  }

  // Helper methods
  private async createIndexFile(
    dataByType: Record<CoALAMemoryType, CoALAMemoryEntry[]>,
  ): Promise<void> {
    const index = {
      lastUpdated: new Date().toISOString(),
      memoryTypes: {} as Record<
        CoALAMemoryType,
        { count: number; latestTimestamp: string | null; avgRelevance: number; fileName: string }
      >,
    };

    for (const memoryType of objectKeys(dataByType)) {
      const data = dataByType[memoryType];
      if (data && data.length > 0) {
        const entries = data;
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
      await writeFile(indexPath, JSON.stringify(index, null, 2), "utf-8");
    });
  }

  private getLatestTimestamp(entries: CoALAMemoryEntry[]): string | null {
    if (!entries.length) return null;

    const timestamps = entries
      .map((entry) => entry.timestamp || entry.lastAccessed)
      .filter((ts) => ts)
      .map((ts) => (typeof ts === "string" ? ts : ts.toISOString()))
      .sort()
      .reverse();

    return timestamps[0] || null;
  }

  private getAverageRelevance(entries: CoALAMemoryEntry[]): number {
    if (!entries.length) return 0;

    const relevanceScores = entries
      .map((entry) => entry.relevanceScore)
      .filter((score) => typeof score === "number");

    if (!relevanceScores.length) return 0;

    return relevanceScores.reduce((sum, score) => sum + score, 0) / relevanceScores.length;
  }

  // Utility methods for memory management
  async getMemoryStatistics(): Promise<Record<string, unknown>> {
    try {
      const indexPath = join(this.storagePath, "index.json");
      const content = await readFile(indexPath, "utf-8");

      // Parse and validate using Zod schema
      const rawData = JSON.parse(content);
      const validatedData = MemoryStatisticsSchema.parse(rawData);

      return validatedData;
    } catch (error) {
      // Handle Zod validation errors
      if (error instanceof z.ZodError) {
        console.warn(
          `Failed to validate memory statistics structure: ${error.message}. Regenerating statistics.`,
        );
      }

      // If index doesn't exist or validation fails, generate statistics on the fly
      const allData = await this.loadAll();
      const stats: Record<string, unknown> = {};

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
}

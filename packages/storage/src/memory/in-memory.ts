/**
 * In-Memory Storage Adapter for Testing
 *
 * Provides a non-persistent storage implementation that keeps all data
 * in memory. Useful for unit tests and scenarios where persistence
 * is not required.
 */

import type { CoALAMemoryEntry, CoALAMemoryType } from "@atlas/memory";
import { objectKeys } from "@atlas/utils";
import type { ICoALAMemoryStorageAdapter } from "../types/core.ts";

export class InMemoryStorageAdapter implements ICoALAMemoryStorageAdapter {
  private dataByType: Record<CoALAMemoryType, CoALAMemoryEntry[]> = {
    working: [],
    episodic: [],
    semantic: [],
    procedural: [],
    contextual: [],
  };

  // Enhanced CoALA-specific methods
  async commitByType(memoryType: CoALAMemoryType, data: CoALAMemoryEntry[]): Promise<void> {
    if (!this.dataByType[memoryType]) {
      this.dataByType[memoryType] = [];
    }
    this.dataByType[memoryType].push(...data);
  }

  async loadByType(memoryType: CoALAMemoryType): Promise<CoALAMemoryEntry[]> {
    return this.dataByType[memoryType] || [];
  }

  async commitAll(dataByType: Record<CoALAMemoryType, CoALAMemoryEntry[]>): Promise<void> {
    // Deep clone to avoid reference issues
    this.dataByType = { working: [], episodic: [], semantic: [], procedural: [], contextual: [] };
    for (const memoryType of objectKeys(dataByType) as CoALAMemoryType[]) {
      const data = dataByType[memoryType];
      if (data && data.length > 0) {
        this.dataByType[memoryType].push(...data);
      }
    }
  }

  async loadAll(): Promise<Record<CoALAMemoryType, CoALAMemoryEntry[]>> {
    // Return a deep clone to avoid external modifications
    const result: Record<CoALAMemoryType, CoALAMemoryEntry[]> = {
      working: [],
      episodic: [],
      semantic: [],
      procedural: [],
      contextual: [],
    };
    for (const memoryType of objectKeys(this.dataByType)) {
      const data = this.dataByType[memoryType];
      if (data && data.length > 0) {
        result[memoryType] = [...data];
      }
    }
    return result;
  }

  listMemoryTypes(): CoALAMemoryType[] {
    return objectKeys(this.dataByType).filter(
      (type) => this.dataByType[type] && this.dataByType[type].length > 0,
    );
  }

  // Test helper methods
  clear(): void {
    this.dataByType = { working: [], episodic: [], semantic: [], procedural: [], contextual: [] };
  }
}

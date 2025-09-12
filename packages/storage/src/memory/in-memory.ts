/**
 * In-Memory Storage Adapter for Testing
 *
 * Provides a non-persistent storage implementation that keeps all data
 * in memory. Useful for unit tests and scenarios where persistence
 * is not required.
 */

import type { MemoryEntry } from "@atlas/memory";
import type { ICoALAMemoryStorageAdapter } from "../types/core.ts";

export class InMemoryStorageAdapter implements ICoALAMemoryStorageAdapter {
  private data: MemoryEntry[] = [];
  private dataByType: Record<string, MemoryEntry[]> = {};

  // Enhanced CoALA-specific methods
  async commitByType(memoryType: string, data: MemoryEntry[]): Promise<void> {
    this.dataByType[memoryType] = { ...data };
  }

  async loadByType(memoryType: string): Promise<MemoryEntry[]> {
    return this.dataByType[memoryType] || [];
  }

  async commitAll(dataByType: Record<string, MemoryEntry[]>): Promise<void> {
    // Deep clone to avoid reference issues
    this.dataByType = {};
    for (const [memoryType, data] of Object.entries(dataByType)) {
      if (data && Object.keys(data).length > 0) {
        this.dataByType[memoryType] = { ...data };
      }
    }
  }

  async loadAll(): Promise<Record<string, MemoryEntry[]>> {
    // Return a deep clone to avoid external modifications
    const result: Record<string, MemoryEntry[]> = {};
    for (const [memoryType, data] of Object.entries(this.dataByType)) {
      if (data && Object.keys(data).length > 0) {
        result[memoryType] = { ...data };
      }
    }
    return result;
  }

  async listMemoryTypes(): Promise<string[]> {
    return Object.keys(this.dataByType).filter(
      (type) => this.dataByType[type] && Object.keys(this.dataByType[type]).length > 0,
    );
  }

  // Test helper methods
  clear(): void {
    this.data = [];
    this.dataByType = {};
  }

  getAllData(): { legacy: MemoryEntry[]; byType: Record<string, MemoryEntry[]> } {
    return { legacy: { ...this.data }, byType: { ...this.dataByType } };
  }
}

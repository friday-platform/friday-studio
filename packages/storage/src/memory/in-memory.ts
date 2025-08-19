/**
 * In-Memory Storage Adapter for Testing
 *
 * Provides a non-persistent storage implementation that keeps all data
 * in memory. Useful for unit tests and scenarios where persistence
 * is not required.
 */

import type { ICoALAMemoryStorageAdapter } from "../types/core.ts";

export class InMemoryStorageAdapter implements ICoALAMemoryStorageAdapter {
  private data: any = {};
  private dataByType: Record<string, any> = {};

  // Legacy compatibility methods
  async commit(data: any): Promise<void> {
    this.data = { ...data };

    // Also organize by memory type for CoALA compatibility
    const organizedData: Record<string, any> = {};

    for (const [key, memory] of Object.entries(data)) {
      const memoryType = memory.memoryType || "working";
      if (!organizedData[memoryType]) {
        organizedData[memoryType] = {};
      }
      organizedData[memoryType][key] = memory;
    }

    await this.commitAll(organizedData);
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
    this.dataByType[memoryType] = { ...data };
  }

  async loadByType(memoryType: string): Promise<any> {
    return this.dataByType[memoryType] || {};
  }

  async commitAll(dataByType: Record<string, any>): Promise<void> {
    // Deep clone to avoid reference issues
    this.dataByType = {};
    for (const [memoryType, data] of Object.entries(dataByType)) {
      if (data && Object.keys(data).length > 0) {
        this.dataByType[memoryType] = { ...data };
      }
    }
  }

  async loadAll(): Promise<Record<string, any>> {
    // Return a deep clone to avoid external modifications
    const result: Record<string, any> = {};
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
    this.data = {};
    this.dataByType = {};
  }

  getAllData(): { legacy: any; byType: Record<string, any> } {
    return {
      legacy: { ...this.data },
      byType: { ...this.dataByType },
    };
  }
}

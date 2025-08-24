/**
 * In-memory supervision cache adapter
 * Fast but not persistent across restarts
 */

import type {
  CacheStats,
  SupervisionCacheAdapter,
  SupervisionCacheEntry,
} from "../supervision-cache.ts";

export class MemoryCacheAdapter implements SupervisionCacheAdapter {
  name = "memory";
  private cache = new Map<string, SupervisionCacheEntry>();
  private stats: CacheStats = {
    totalEntries: 0,
    totalHits: 0,
    totalMisses: 0,
    hitRate: 0,
    averageAge: 0,
    memoryUsage: 0,
  };

  async get(key: string): Promise<SupervisionCacheEntry | null> {
    const entry = this.cache.get(key);
    if (entry) {
      this.stats.totalHits++;
      return { ...entry }; // Return copy to prevent mutations
    }
    this.stats.totalMisses++;
    return null;
  }

  async set(key: string, entry: SupervisionCacheEntry): Promise<void> {
    const isNew = !this.cache.has(key);
    this.cache.set(key, { ...entry }); // Store copy

    if (isNew) {
      this.stats.totalEntries++;
    }

    this.updateMemoryUsage();
  }

  async delete(key: string): Promise<boolean> {
    const existed = this.cache.delete(key);
    if (existed) {
      this.stats.totalEntries--;
      this.updateMemoryUsage();
    }
    return existed;
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.stats.totalEntries = 0;
    this.stats.memoryUsage = 0;
  }

  async getMultiple(keys: string[]): Promise<Map<string, SupervisionCacheEntry>> {
    const result = new Map<string, SupervisionCacheEntry>();

    for (const key of keys) {
      const entry = this.cache.get(key);
      if (entry) {
        result.set(key, { ...entry });
        this.stats.totalHits++;
      } else {
        this.stats.totalMisses++;
      }
    }

    return result;
  }

  async setMultiple(entries: Map<string, SupervisionCacheEntry>): Promise<void> {
    let newEntries = 0;

    for (const [key, entry] of entries) {
      const isNew = !this.cache.has(key);
      this.cache.set(key, { ...entry });

      if (isNew) {
        newEntries++;
      }
    }

    this.stats.totalEntries += newEntries;
    this.updateMemoryUsage();
  }

  async size(): Promise<number> {
    return this.cache.size;
  }

  async keys(): Promise<string[]> {
    return Array.from(this.cache.keys());
  }

  async cleanup(): Promise<number> {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.cache) {
      if (entry.ttl && now - entry.timestamp > entry.ttl) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.stats.totalEntries -= cleaned;
      this.updateMemoryUsage();
    }

    return cleaned;
  }

  async getStats(): Promise<CacheStats> {
    this.updateStats();
    return { ...this.stats };
  }

  private updateMemoryUsage(): void {
    // Rough memory estimation
    let bytes = 0;
    for (const [key, entry] of this.cache) {
      bytes += key.length * 2; // UTF-16 chars
      bytes += JSON.stringify(entry).length * 2;
    }
    this.stats.memoryUsage = bytes;
  }

  private updateStats(): void {
    if (this.stats.totalHits + this.stats.totalMisses > 0) {
      this.stats.hitRate = this.stats.totalHits / (this.stats.totalHits + this.stats.totalMisses);
    }

    // Calculate average age
    if (this.cache.size > 0) {
      const now = Date.now();
      let totalAge = 0;
      for (const entry of this.cache.values()) {
        totalAge += now - entry.timestamp;
      }
      this.stats.averageAge = totalAge / this.cache.size;
    }
  }
}

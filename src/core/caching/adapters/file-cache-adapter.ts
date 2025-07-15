/**
 * File-based supervision cache adapter
 * Persistent local storage, good for development/single-instance deployments
 */

import { ensureDir, exists } from "@std/fs";
import { join } from "@std/path";
import type {
  CacheStats,
  SupervisionCacheAdapter,
  SupervisionCacheEntry,
} from "../supervision-cache.ts";

export interface FileCacheConfig {
  cacheDir?: string;
  maxFileSize?: number; // Max size per cache file in bytes
  compressionEnabled?: boolean;
  syncWrites?: boolean; // Whether to sync writes to disk immediately
}

export class FileCacheAdapter implements SupervisionCacheAdapter {
  name = "file";
  private cacheDir: string;
  private config: FileCacheConfig;
  private stats: CacheStats = {
    totalEntries: 0,
    totalHits: 0,
    totalMisses: 0,
    hitRate: 0,
    averageAge: 0,
  };

  constructor(config: FileCacheConfig = {}) {
    this.config = {
      cacheDir: config.cacheDir || ".atlas/cache/supervision",
      maxFileSize: config.maxFileSize || 10 * 1024 * 1024, // 10MB
      compressionEnabled: config.compressionEnabled || false,
      syncWrites: config.syncWrites || false,
      ...config,
    };
    this.cacheDir = this.config.cacheDir!;
  }

  async initialize(): Promise<void> {
    await ensureDir(this.cacheDir);
    console.log(`File supervision cache initialized at: ${this.cacheDir}`);
  }

  private getFilePath(key: string): string {
    // Use first 2 chars for directory sharding to avoid too many files in one dir
    const shard = key.substring(0, 2);
    return join(this.cacheDir, shard, `${key}.json`);
  }

  private async ensureShardDir(key: string): Promise<void> {
    const shard = key.substring(0, 2);
    const shardDir = join(this.cacheDir, shard);
    await ensureDir(shardDir);
  }

  async get(key: string): Promise<SupervisionCacheEntry | null> {
    try {
      const filePath = this.getFilePath(key);

      if (!(await exists(filePath))) {
        this.stats.totalMisses++;
        return null;
      }

      const data = await Deno.readTextFile(filePath);
      let parsed: SupervisionCacheEntry;

      if (this.config.compressionEnabled) {
        // TODO: Add compression/decompression logic
        parsed = JSON.parse(data);
      } else {
        parsed = JSON.parse(data);
      }

      this.stats.totalHits++;
      return parsed;
    } catch (error) {
      console.error(`File cache get error for key ${key}:`, error);
      this.stats.totalMisses++;
      return null;
    }
  }

  async set(key: string, entry: SupervisionCacheEntry): Promise<void> {
    try {
      await this.ensureShardDir(key);
      const filePath = this.getFilePath(key);

      let data: string;
      if (this.config.compressionEnabled) {
        // TODO: Add compression logic
        data = JSON.stringify(entry, null, 2);
      } else {
        data = JSON.stringify(entry, null, 2);
      }

      // Check file size limits
      if (data.length > this.config.maxFileSize!) {
        console.warn(
          `Cache entry too large for key ${key}: ${data.length} bytes`,
        );
        return;
      }

      await Deno.writeTextFile(filePath, data);

      if (this.config.syncWrites) {
        // Force sync to disk (slower but more durable)
        const file = await Deno.open(filePath, { read: true });
        await file.sync();
        file.close();
      }

      this.stats.totalEntries++;
    } catch (error) {
      console.error(`File cache set error for key ${key}:`, error);
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      const filePath = this.getFilePath(key);

      if (await exists(filePath)) {
        await Deno.remove(filePath);
        this.stats.totalEntries--;
        return true;
      }

      return false;
    } catch (error) {
      console.error(`File cache delete error for key ${key}:`, error);
      return false;
    }
  }

  async clear(): Promise<void> {
    try {
      // Remove entire cache directory and recreate
      if (await exists(this.cacheDir)) {
        await Deno.remove(this.cacheDir, { recursive: true });
      }
      await ensureDir(this.cacheDir);
      this.stats.totalEntries = 0;
    } catch (error) {
      console.error("File cache clear error:", error);
    }
  }

  async getMultiple(
    keys: string[],
  ): Promise<Map<string, SupervisionCacheEntry>> {
    const result = new Map<string, SupervisionCacheEntry>();

    // Process in parallel with concurrency limit
    const concurrency = 10;
    for (let i = 0; i < keys.length; i += concurrency) {
      const batch = keys.slice(i, i + concurrency);
      const promises = batch.map(async (key) => {
        const entry = await this.get(key);
        if (entry) {
          result.set(key, entry);
        }
      });

      await Promise.all(promises);
    }

    return result;
  }

  async setMultiple(
    entries: Map<string, SupervisionCacheEntry>,
  ): Promise<void> {
    // Process in parallel with concurrency limit
    const concurrency = 10;
    const entryArray = Array.from(entries.entries());

    for (let i = 0; i < entryArray.length; i += concurrency) {
      const batch = entryArray.slice(i, i + concurrency);
      const promises = batch.map(([key, entry]) => this.set(key, entry));

      await Promise.all(promises);
    }
  }

  async size(): Promise<number> {
    try {
      let count = 0;

      // Count files in all shard directories
      for await (const dirEntry of Deno.readDir(this.cacheDir)) {
        if (dirEntry.isDirectory) {
          const shardPath = join(this.cacheDir, dirEntry.name);
          try {
            for await (const fileEntry of Deno.readDir(shardPath)) {
              if (fileEntry.isFile && fileEntry.name.endsWith(".json")) {
                count++;
              }
            }
          } catch {
            // Shard directory might not exist or be readable
          }
        }
      }

      return count;
    } catch (error) {
      console.error("File cache size error:", error);
      return 0;
    }
  }

  async keys(): Promise<string[]> {
    try {
      const keys: string[] = [];

      // Collect keys from all shard directories
      for await (const dirEntry of Deno.readDir(this.cacheDir)) {
        if (dirEntry.isDirectory) {
          const shardPath = join(this.cacheDir, dirEntry.name);
          try {
            for await (const fileEntry of Deno.readDir(shardPath)) {
              if (fileEntry.isFile && fileEntry.name.endsWith(".json")) {
                // Remove .json extension to get key
                const key = fileEntry.name.replace(".json", "");
                keys.push(key);
              }
            }
          } catch {
            // Shard directory might not exist or be readable
          }
        }
      }

      return keys;
    } catch (error) {
      console.error("File cache keys error:", error);
      return [];
    }
  }

  async cleanup(): Promise<number> {
    try {
      let cleaned = 0;
      const now = Date.now();

      const keys = await this.keys();
      for (const key of keys) {
        const entry = await this.get(key);
        if (entry && entry.ttl && now - entry.timestamp > entry.ttl) {
          const deleted = await this.delete(key);
          if (deleted) {
            cleaned++;
          }
        }
      }

      return cleaned;
    } catch (error) {
      console.error("File cache cleanup error:", error);
      return 0;
    }
  }

  async getStats(): Promise<CacheStats> {
    // Update total entries count
    this.stats.totalEntries = await this.size();

    if (this.stats.totalHits + this.stats.totalMisses > 0) {
      this.stats.hitRate = this.stats.totalHits / (this.stats.totalHits + this.stats.totalMisses);
    }

    // Calculate average age by sampling
    try {
      const keys = await this.keys();
      if (keys.length > 0) {
        const sampleSize = Math.min(100, keys.length);
        const sampleKeys = keys.slice(0, sampleSize);

        let totalAge = 0;
        let validSamples = 0;

        for (const key of sampleKeys) {
          const entry = await this.get(key);
          if (entry) {
            totalAge += Date.now() - entry.timestamp;
            validSamples++;
          }
        }

        if (validSamples > 0) {
          this.stats.averageAge = totalAge / validSamples;
        }
      }
    } catch (error) {
      console.error("Error calculating average age:", error);
    }

    return { ...this.stats };
  }
}

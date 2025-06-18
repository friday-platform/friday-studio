/**
 * Redis supervision cache adapter
 * Persistent and can be shared across Atlas instances
 */

import type {
  CacheStats,
  SupervisionCacheAdapter,
  SupervisionCacheEntry,
} from "../supervision-cache.ts";

export interface RedisConfig {
  host?: string;
  port?: number;
  password?: string;
  db?: number;
  keyPrefix?: string;
  maxRetries?: number;
  retryDelayMs?: number;
}

export class RedisCacheAdapter implements SupervisionCacheAdapter {
  name = "redis";
  private redis: any; // Redis client
  private config: RedisConfig;
  private keyPrefix: string;
  private stats: CacheStats = {
    totalEntries: 0,
    totalHits: 0,
    totalMisses: 0,
    hitRate: 0,
    averageAge: 0,
  };

  constructor(config: RedisConfig = {}) {
    this.config = {
      host: config.host || "localhost",
      port: config.port || 6379,
      password: config.password,
      db: config.db || 0,
      keyPrefix: config.keyPrefix || "atlas:supervision:",
      maxRetries: config.maxRetries || 3,
      retryDelayMs: config.retryDelayMs || 1000,
      ...config,
    };
    this.keyPrefix = this.config.keyPrefix!;
  }

  async connect(): Promise<void> {
    try {
      // Dynamic import of Redis (optional dependency)
      const { createClient } = await import("redis");

      this.redis = createClient({
        socket: {
          host: this.config.host,
          port: this.config.port,
        },
        password: this.config.password,
        database: this.config.db,
      });

      this.redis.on("error", (err: Error) => {
        console.error("Redis supervision cache error:", err);
      });

      await this.redis.connect();
      console.log(
        `Connected to Redis supervision cache at ${this.config.host}:${this.config.port}`,
      );
    } catch (error) {
      console.error("Failed to connect to Redis:", error);
      throw new Error("Redis connection failed - is Redis installed and running?");
    }
  }

  async disconnect(): Promise<void> {
    if (this.redis) {
      await this.redis.quit();
    }
  }

  private getKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  async get(key: string): Promise<SupervisionCacheEntry | null> {
    if (!this.redis) await this.connect();

    try {
      const data = await this.redis.get(this.getKey(key));
      if (!data) {
        this.stats.totalMisses++;
        return null;
      }

      const entry = JSON.parse(data) as SupervisionCacheEntry;
      this.stats.totalHits++;
      return entry;
    } catch (error) {
      console.error(`Redis get error for key ${key}:`, error);
      this.stats.totalMisses++;
      return null;
    }
  }

  async set(key: string, entry: SupervisionCacheEntry): Promise<void> {
    if (!this.redis) await this.connect();

    try {
      const data = JSON.stringify(entry);
      const redisKey = this.getKey(key);

      if (entry.ttl) {
        // Set with expiration
        await this.redis.setEx(redisKey, Math.ceil(entry.ttl / 1000), data);
      } else {
        await this.redis.set(redisKey, data);
      }

      this.stats.totalEntries++;
    } catch (error) {
      console.error(`Redis set error for key ${key}:`, error);
    }
  }

  async delete(key: string): Promise<boolean> {
    if (!this.redis) await this.connect();

    try {
      const result = await this.redis.del(this.getKey(key));
      if (result > 0) {
        this.stats.totalEntries--;
        return true;
      }
      return false;
    } catch (error) {
      console.error(`Redis delete error for key ${key}:`, error);
      return false;
    }
  }

  async clear(): Promise<void> {
    if (!this.redis) await this.connect();

    try {
      const keys = await this.redis.keys(`${this.keyPrefix}*`);
      if (keys.length > 0) {
        await this.redis.del(keys);
        this.stats.totalEntries = 0;
      }
    } catch (error) {
      console.error("Redis clear error:", error);
    }
  }

  async getMultiple(keys: string[]): Promise<Map<string, SupervisionCacheEntry>> {
    if (!this.redis) await this.connect();

    const result = new Map<string, SupervisionCacheEntry>();

    try {
      const redisKeys = keys.map((k) => this.getKey(k));
      const values = await this.redis.mGet(redisKeys);

      for (let i = 0; i < keys.length; i++) {
        const data = values[i];
        if (data) {
          try {
            const entry = JSON.parse(data) as SupervisionCacheEntry;
            result.set(keys[i], entry);
            this.stats.totalHits++;
          } catch (parseError) {
            console.error(`Redis parse error for key ${keys[i]}:`, parseError);
            this.stats.totalMisses++;
          }
        } else {
          this.stats.totalMisses++;
        }
      }
    } catch (error) {
      console.error("Redis getMultiple error:", error);
      // Mark all as misses
      this.stats.totalMisses += keys.length;
    }

    return result;
  }

  async setMultiple(entries: Map<string, SupervisionCacheEntry>): Promise<void> {
    if (!this.redis) await this.connect();

    try {
      const pipeline = this.redis.multi();

      for (const [key, entry] of entries) {
        const data = JSON.stringify(entry);
        const redisKey = this.getKey(key);

        if (entry.ttl) {
          pipeline.setEx(redisKey, Math.ceil(entry.ttl / 1000), data);
        } else {
          pipeline.set(redisKey, data);
        }
      }

      await pipeline.exec();
      this.stats.totalEntries += entries.size;
    } catch (error) {
      console.error("Redis setMultiple error:", error);
    }
  }

  async size(): Promise<number> {
    if (!this.redis) await this.connect();

    try {
      const keys = await this.redis.keys(`${this.keyPrefix}*`);
      return keys.length;
    } catch (error) {
      console.error("Redis size error:", error);
      return 0;
    }
  }

  async keys(): Promise<string[]> {
    if (!this.redis) await this.connect();

    try {
      const redisKeys = await this.redis.keys(`${this.keyPrefix}*`);
      return redisKeys.map((k: string) => k.replace(this.keyPrefix, ""));
    } catch (error) {
      console.error("Redis keys error:", error);
      return [];
    }
  }

  async cleanup(): Promise<number> {
    // Redis handles TTL expiration automatically
    // This method could be used for manual cleanup of old entries
    return 0;
  }

  async getStats(): Promise<CacheStats> {
    // Update total entries count
    this.stats.totalEntries = await this.size();

    if (this.stats.totalHits + this.stats.totalMisses > 0) {
      this.stats.hitRate = this.stats.totalHits / (this.stats.totalHits + this.stats.totalMisses);
    }

    return { ...this.stats };
  }
}

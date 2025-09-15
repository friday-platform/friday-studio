/// <reference lib="deno.unstable" />

/**
 * Deno KV Storage Implementation
 *
 * This implementation completely hides Deno.Kv types behind the KVStorage interface,
 * ensuring that no storage-specific types leak into the business logic layer.
 */

import {
  type AtomicOperation,
  KVConnectionError,
  type KVEntry,
  type KVStorage,
  KVStorageError,
  KVTransactionError,
  type WatchEvent,
} from "./kv-storage.ts";

/**
 * Deno KV implementation of AtomicOperation
 * Wraps Deno.AtomicOperation without exposing its types
 */
class DenoKVAtomicOperation implements AtomicOperation {
  constructor(private operation: Deno.AtomicOperation) {}

  set<T>(key: string[], value: T): AtomicOperation {
    this.operation = this.operation.set(key, value);
    return this;
  }

  delete(key: string[]): AtomicOperation {
    this.operation = this.operation.delete(key);
    return this;
  }

  check<T>(key: string[], expectedValue: T | null): AtomicOperation {
    // Store check for validation during commit
    // Deno KV check API requires a KvEntryMaybe object
    const checkEntry = { key, value: expectedValue, versionstamp: null };
    this.operation = this.operation.check(checkEntry);
    return this;
  }

  async commit(): Promise<boolean> {
    try {
      const result = await this.operation.commit();
      return result.ok;
    } catch (error) {
      throw new KVTransactionError(
        `Failed to commit atomic operation: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }
}

type StorageState = "uninitialized" | "initializing" | "ready" | "closed";

/**
 * Deno KV Storage Implementation
 *
 * Provides a clean KVStorage interface over Deno.Kv, completely hiding
 * Deno-specific types and APIs from the rest of the application.
 */
export class DenoKVStorage implements KVStorage {
  private kv: Deno.Kv | null = null;
  private path?: string;
  private state: StorageState = "uninitialized";
  private initializationPromise: Promise<void> | null = null;

  constructor(path?: string) {
    this.path = path;
  }

  async initialize(): Promise<void> {
    switch (this.state) {
      case "ready":
        return; // Already initialized

      case "initializing":
        // If already initializing, wait for the existing initialization to complete
        if (this.initializationPromise) {
          return this.initializationPromise;
        }
        throw new Error("Storage is initializing but no promise is available");

      case "closed":
        throw new KVStorageError(
          "Storage has been closed and cannot be reinitialized",
          "STORAGE_CLOSED",
        );

      case "uninitialized":
        // Proceed with initialization
        break;
    }

    // Set state and create initialization promise
    this.state = "initializing";
    this.initializationPromise = this.doInitialize();

    try {
      await this.initializationPromise;
    } finally {
      // Clear the promise after completion (success or failure)
      this.initializationPromise = null;
    }
  }

  private async doInitialize(): Promise<void> {
    try {
      // Ensure parent directory exists for file-based KV
      if (this.path) {
        const dir = this.path.substring(0, this.path.lastIndexOf("/"));
        if (dir) {
          await Deno.mkdir(dir, { recursive: true });
        }
      }

      this.kv = await Deno.openKv(this.path);
      this.state = "ready";
    } catch (error) {
      // Reset state on failure
      this.state = "uninitialized";
      throw new KVConnectionError(
        `Failed to initialize Deno KV storage at ${this.path || "default location"}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private ensureReady(): void {
    if (this.state !== "ready") {
      throw new KVStorageError(
        `Storage is not ready (current state: ${this.state})`,
        "NOT_INITIALIZED",
      );
    }
    if (!this.kv) {
      throw new KVStorageError(
        "Storage is in ready state but KV instance is missing",
        "INVALID_STATE",
      );
    }
  }

  async get<T>(key: string[]): Promise<T | null> {
    this.ensureReady();

    try {
      const result = await this.kv!.get<T>(key);
      return result.value;
    } catch (error) {
      throw new KVStorageError(
        `Failed to get key [${key.join(", ")}]: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "GET_FAILED",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  async set<T>(key: string[], value: T): Promise<void> {
    this.ensureReady();

    try {
      await this.kv!.set(key, value);
    } catch (error) {
      throw new KVStorageError(
        `Failed to set key [${key.join(", ")}]: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "SET_FAILED",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  async delete(key: string[]): Promise<void> {
    this.ensureReady();

    try {
      await this.kv!.delete(key);
    } catch (error) {
      throw new KVStorageError(
        `Failed to delete key [${key.join(", ")}]: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "DELETE_FAILED",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  async *list<T>(prefix: string[]): AsyncIterableIterator<KVEntry<T>> {
    this.ensureReady();

    try {
      const iter = this.kv!.list<T>({ prefix });

      for await (const entry of iter) {
        yield {
          key: entry.key, // Deno KV keys are always string arrays
          value: entry.value,
          versionstamp: entry.versionstamp,
        };
      }
    } catch (error) {
      throw new KVStorageError(
        `Failed to list entries with prefix [${prefix.join(", ")}]: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "LIST_FAILED",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  async *watch<T>(prefix: string[]): AsyncIterable<WatchEvent<T>[]> {
    this.ensureReady();

    try {
      // Deno KV watch expects an array of key arrays to watch
      const watcher = this.kv!.watch([prefix]);

      for await (const entries of watcher) {
        const events: WatchEvent<T>[] = [];

        // entries is a tuple of KvEntryMaybe<unknown>[]
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          if (entry) {
            events.push({
              key: entry.key,
              value: entry.value,
              versionstamp: entry.versionstamp ?? undefined,
            });
          }
        }

        yield events;
      }
    } catch (error) {
      throw new KVStorageError(
        `Failed to watch prefix [${prefix.join(", ")}]: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "WATCH_FAILED",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  atomic(): AtomicOperation {
    this.ensureReady();

    return new DenoKVAtomicOperation(this.kv!.atomic());
  }

  async health(): Promise<boolean> {
    if (this.state !== "ready" || !this.kv) {
      return false;
    }

    try {
      // Perform a simple health check by attempting to get a non-existent key
      await this.kv.get(["__health_check__"]);
      return true;
    } catch {
      return false;
    }
  }

  async stats(): Promise<{
    totalKeys: number;
    totalSize: number;
    isConnected: boolean;
    lastError?: string;
  }> {
    const isConnected = await this.health();

    if (!isConnected) {
      return { totalKeys: 0, totalSize: 0, isConnected: false, lastError: "Storage not connected" };
    }

    try {
      // Count keys by iterating through all entries
      // Note: This is expensive for large datasets, but Deno KV doesn't provide count operations
      let totalKeys = 0;
      let totalSize = 0;

      for await (const _entry of this.list([])) {
        totalKeys++;
        // Approximate size calculation (rough estimate)
        totalSize += JSON.stringify(_entry.value).length;
      }

      return { totalKeys, totalSize, isConnected: true };
    } catch (error) {
      return {
        totalKeys: 0,
        totalSize: 0,
        isConnected: false,
        lastError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async close(): Promise<void> {
    if (this.state === "closed") {
      return; // Already closed
    }

    if (this.state === "initializing" && this.initializationPromise) {
      // Wait for initialization to complete before closing
      await this.initializationPromise.catch(() => {}); // Ignore initialization errors
    }

    if (this.kv) {
      try {
        this.kv.close();
        this.kv = null;
      } catch (error) {
        throw new KVStorageError(
          `Failed to close storage: ${error instanceof Error ? error.message : String(error)}`,
          "CLOSE_FAILED",
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    this.state = "closed";
  }
}

/**
 * Create a configured Deno KV storage instance
 * @param path Optional path for the KV database file
 * @returns Initialized DenoKVStorage instance
 */
async function createDenoKVStorage(path?: string): Promise<DenoKVStorage> {
  const storage = new DenoKVStorage(path);
  await storage.initialize();
  return storage;
}

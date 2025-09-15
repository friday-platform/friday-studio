/**
 * In-Memory Key-Value Storage Implementation
 *
 * A simple in-memory implementation of KVStorage for testing and development.
 * Data is not persisted and will be lost when the process exits.
 */

import {
  type AtomicOperation,
  type KVEntry,
  type KVStorage,
  KVStorageError,
  KVTransactionError,
  type WatchEvent,
} from "./kv-storage.ts";

/**
 * In-memory atomic operation implementation
 */
class MemoryAtomicOperation implements AtomicOperation {
  private operations: Array<{
    type: "set" | "delete" | "check";
    key: string[];
    value?: unknown;
    expectedValue?: unknown;
  }> = [];

  constructor(private storage: MemoryKVStorage) {}

  set<T>(key: string[], value: T): AtomicOperation {
    this.operations.push({ type: "set", key: [...key], value });
    return this;
  }

  delete(key: string[]): AtomicOperation {
    this.operations.push({ type: "delete", key: [...key] });
    return this;
  }

  check<T>(key: string[], expectedValue: T | null): AtomicOperation {
    this.operations.push({ type: "check", key: [...key], expectedValue });
    return this;
  }

  async commit(): Promise<boolean> {
    try {
      // Validate all checks first
      for (const op of this.operations) {
        if (op.type === "check") {
          const currentValue = this.storage.getData().get(this.keyToString(op.key));
          if (currentValue !== op.expectedValue) {
            return false; // Check failed
          }
        }
      }

      // Apply all operations atomically
      for (const op of this.operations) {
        if (op.type === "set") {
          this.storage.getData().set(this.keyToString(op.key), op.value);
        } else if (op.type === "delete") {
          this.storage.getData().delete(this.keyToString(op.key));
        }
      }

      // Notify watchers
      this.storage.notifyWatchers();

      return true;
    } catch (error) {
      throw new KVTransactionError(
        `Failed to commit atomic operation: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private keyToString(key: string[]): string {
    return key.join("\u0000"); // Use null separator to avoid conflicts
  }
}

/**
 * In-Memory Key-Value Storage Implementation
 *
 * Simple implementation using Map for storage. Useful for testing
 * and development where persistence is not required.
 */
export class MemoryKVStorage implements KVStorage {
  private data = new Map<string, unknown>();
  private watchers = new Set<(events: WatchEvent<unknown>[]) => void>();
  private isInitialized = false;

  async initialize(): Promise<void> {
    this.isInitialized = true;
    this.data.clear();
    this.watchers.clear();
  }

  async get<T>(key: string[]): Promise<T | null> {
    if (!this.isInitialized) {
      throw new KVStorageError("Storage not initialized", "NOT_INITIALIZED");
    }

    const keyString = this.keyToString(key);
    const value = this.data.get(keyString);
    return value !== undefined ? value : null;
  }

  async set<T>(key: string[], value: T): Promise<void> {
    if (!this.isInitialized) {
      throw new KVStorageError("Storage not initialized", "NOT_INITIALIZED");
    }

    const keyString = this.keyToString(key);
    this.data.set(keyString, value);

    // Notify watchers
    this.notifyWatchers([{ key: [...key], value }]);
  }

  async delete(key: string[]): Promise<void> {
    if (!this.isInitialized) {
      throw new KVStorageError("Storage not initialized", "NOT_INITIALIZED");
    }

    const keyString = this.keyToString(key);
    const existed = this.data.has(keyString);
    this.data.delete(keyString);

    if (existed) {
      // Notify watchers of deletion
      this.notifyWatchers([{ key: [...key], value: null }]);
    }
  }

  async *list<T>(prefix: string[]): AsyncIterableIterator<KVEntry<T>> {
    if (!this.isInitialized) {
      throw new KVStorageError("Storage not initialized", "NOT_INITIALIZED");
    }

    const prefixString = this.keyToString(prefix);

    for (const [keyString, value] of this.data.entries()) {
      if (keyString.startsWith(prefixString)) {
        const key = this.stringToKey(keyString);
        yield {
          key,
          value: value,
          versionstamp: Date.now().toString(), // Simple versioning
        };
      }
    }
  }

  async *watch<T>(prefix: string[]): AsyncIterable<WatchEvent<T>[]> {
    if (!this.isInitialized) {
      throw new KVStorageError("Storage not initialized", "NOT_INITIALIZED");
    }

    const prefixString = this.keyToString(prefix);

    // Create a channel for watch events
    const watcherQueue: WatchEvent<T>[] = [];
    let resolveNext: ((value: WatchEvent<T>[]) => void) | null = null;

    const watcher = (events: WatchEvent<unknown>[]) => {
      // Filter events that match the prefix
      const matchingEvents: WatchEvent<T>[] = events
        .filter((event) => this.keyToString(event.key).startsWith(prefixString))
        .map((event) => ({ ...event, value: event.value }));

      if (matchingEvents.length > 0) {
        if (resolveNext) {
          resolveNext(matchingEvents);
          resolveNext = null;
        } else {
          watcherQueue.push(...matchingEvents);
        }
      }
    };

    this.watchers.add(watcher);

    try {
      while (true) {
        if (watcherQueue.length > 0) {
          const batch = watcherQueue.splice(0, watcherQueue.length);
          yield batch;
        } else {
          const events = await new Promise<WatchEvent<T>[]>((resolve) => {
            resolveNext = resolve;
          });
          yield events;
        }
      }
    } finally {
      this.watchers.delete(watcher);
    }
  }

  atomic(): AtomicOperation {
    if (!this.isInitialized) {
      throw new KVStorageError("Storage not initialized", "NOT_INITIALIZED");
    }

    return new MemoryAtomicOperation(this);
  }

  async health(): Promise<boolean> {
    return this.isInitialized;
  }

  async stats(): Promise<{
    totalKeys: number;
    totalSize: number;
    isConnected: boolean;
    lastError?: string;
  }> {
    if (!this.isInitialized) {
      return {
        totalKeys: 0,
        totalSize: 0,
        isConnected: false,
        lastError: "Storage not initialized",
      };
    }

    let totalSize = 0;
    for (const [key, value] of this.data.entries()) {
      totalSize += key.length + JSON.stringify(value).length;
    }

    return { totalKeys: this.data.size, totalSize, isConnected: true };
  }

  async close(): Promise<void> {
    this.data.clear();
    this.watchers.clear();
    this.isInitialized = false;
  }

  // Internal methods for testing and atomic operations
  getData(): Map<string, unknown> {
    return this.data;
  }

  notifyWatchers(events?: WatchEvent<unknown>[]): void {
    if (!events) {
      // Generate events for all current data (used by atomic operations)
      events = Array.from(this.data.entries()).map(([keyString, value]) => ({
        key: this.stringToKey(keyString),
        value,
      }));
    }

    for (const watcher of this.watchers) {
      try {
        watcher(events);
      } catch (error) {
        // Ignore watcher errors to prevent them from affecting storage operations
        console.warn("Watcher error:", error);
      }
    }
  }

  private keyToString(key: string[]): string {
    return key.join("\u0000"); // Use null separator to avoid conflicts
  }

  private stringToKey(keyString: string): string[] {
    return keyString.split("\u0000");
  }
}

/**
 * Create a configured in-memory storage instance
 * @returns Initialized MemoryKVStorage instance
 */
async function createMemoryKVStorage(): Promise<MemoryKVStorage> {
  const storage = new MemoryKVStorage();
  await storage.initialize();
  return storage;
}

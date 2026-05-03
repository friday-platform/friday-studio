/**
 * In-Memory Key-Value Storage Implementation
 *
 * A simple in-memory implementation of KVStorage for testing and development.
 * Data is not persisted and will be lost when the process exits.
 */

import type { AtomicOperation, KVEntry, KVStorage } from "./kv-storage.ts";

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

  set<T>(key: string[], value: T) {
    this.operations.push({ type: "set", key: [...key], value });
    return this;
  }

  delete(key: string[]) {
    this.operations.push({ type: "delete", key: [...key] });
    return this;
  }

  check<T>(key: string[], expectedValue: T | null) {
    this.operations.push({ type: "check", key: [...key], expectedValue });
    return this;
  }

  commit() {
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

      return true;
    } catch (error) {
      throw new Error(
        `Failed to commit atomic operation: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
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
  private isInitialized = false;

  initialize() {
    this.isInitialized = true;
    this.data.clear();
  }

  get<T>(key: string[]) {
    if (!this.isInitialized) {
      throw new Error("Storage not initialized");
    }
    const keyString = this.keyToString(key);
    const value = this.data.get(keyString);
    return (value !== undefined ? value : null) as T | null;
  }

  set<T>(key: string[], value: T) {
    if (!this.isInitialized) {
      throw new Error("Storage not initialized");
    }

    const keyString = this.keyToString(key);
    this.data.set(keyString, value);
  }

  delete(key: string[]) {
    if (!this.isInitialized) {
      throw new Error("Storage not initialized");
    }

    const keyString = this.keyToString(key);
    this.data.delete(keyString);
  }

  // @ts-expect-error issue with narrowing Deno.KVKey in the `*list` asyncIterator.
  async *list<T>(prefix: string[]): AsyncIterableIterator<KVEntry<T>> {
    if (!this.isInitialized) {
      throw new Error("Storage not initialized");
    }

    const prefixString = this.keyToString(prefix);

    for (const [keyString, value] of this.data.entries()) {
      if (keyString.startsWith(prefixString)) {
        const key = this.stringToKey(keyString);
        yield { key, value: value as T, versionstamp: Date.now().toString() };
      }
    }
  }

  atomic(): AtomicOperation {
    if (!this.isInitialized) {
      throw new Error("Storage not initialized");
    }

    return new MemoryAtomicOperation(this);
  }

  health() {
    return this.isInitialized;
  }

  close() {
    this.data.clear();
    this.isInitialized = false;
  }

  // Internal methods for testing and atomic operations
  getData() {
    return this.data;
  }

  private keyToString(key: string[]) {
    return key.join("\u0000"); // Use null separator to avoid conflicts
  }

  private stringToKey(keyString: string) {
    return keyString.split("\u0000");
  }
}

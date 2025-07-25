/**
 * Foundational Key-Value Storage Interface
 *
 * This interface provides a clean abstraction over key-value storage systems,
 * completely hiding implementation details like Deno.Kv types. All storage
 * adapters and business logic should use this interface instead of directly
 * accessing storage-specific APIs.
 */

/**
 * Atomic operation builder for transactional consistency
 */
export interface AtomicOperation {
  /**
   * Set a key-value pair in the atomic operation
   */
  set<T>(key: string[], value: T): AtomicOperation;

  /**
   * Delete a key in the atomic operation
   */
  delete(key: string[]): AtomicOperation;

  /**
   * Check that a key has a specific value before committing
   * Used for optimistic concurrency control
   */
  check<T>(key: string[], expectedValue: T | null): AtomicOperation;

  /**
   * Commit the atomic operation
   * @returns true if successful, false if any checks failed
   */
  commit(): Promise<boolean>;
}

/**
 * Entry returned by list operations
 */
export interface KVEntry<T> {
  key: string[];
  value: T;
  versionstamp?: string; // Optional version for optimistic concurrency
}

/**
 * Watch event for real-time updates
 */
export interface WatchEvent<T> {
  key: string[];
  value: T | null; // null indicates deletion
  versionstamp?: string;
}

/**
 * Base Key-Value Storage Interface
 *
 * This is the foundational interface that all storage implementations must satisfy.
 * It provides a clean, storage-agnostic API that completely hides implementation
 * details like Deno.Kv, Redis, PostgreSQL, etc.
 */
export interface KVStorage {
  /**
   * Initialize the storage system
   * Should be called once before any operations
   */
  initialize(): Promise<void>;

  /**
   * Get a value by key
   * @param key Hierarchical key path (e.g., ["workspaces", "abc123"])
   * @returns Value if found, null if not found
   */
  get<T>(key: string[]): Promise<T | null>;

  /**
   * Set a key-value pair
   * @param key Hierarchical key path
   * @param value Value to store
   */
  set<T>(key: string[], value: T): Promise<void>;

  /**
   * Delete a key
   * @param key Hierarchical key path
   */
  delete(key: string[]): Promise<void>;

  /**
   * List all entries with a given key prefix
   * @param prefix Key prefix to match (e.g., ["workspaces"] matches all workspace keys)
   * @returns Async iterator of matching entries
   */
  list<T>(prefix: string[]): AsyncIterableIterator<KVEntry<T>>;

  /**
   * Watch for changes to keys with a given prefix
   * @param prefix Key prefix to watch
   * @returns Async iterable of change events
   */
  watch<T>(prefix: string[]): AsyncIterable<WatchEvent<T>[]>;

  /**
   * Create an atomic operation for transactional consistency
   * @returns Atomic operation builder
   */
  atomic(): AtomicOperation;

  /**
   * Check if the storage system is healthy and accessible
   * @returns true if healthy, false otherwise
   */
  health(): Promise<boolean>;

  /**
   * Get storage statistics and metadata
   */
  stats(): Promise<{
    totalKeys: number;
    totalSize: number;
    isConnected: boolean;
    lastError?: string;
  }>;

  /**
   * Close the storage connection and cleanup resources
   */
  close(): Promise<void>;
}

/**
 * Storage configuration options
 */
export interface KVStorageConfig {
  /**
   * Storage backend type
   */
  type: "deno-kv" | "memory" | "redis" | "postgres";

  /**
   * Connection string or path (implementation-specific)
   */
  connection?: string;

  /**
   * Additional storage-specific options
   */
  options?: Record<string, unknown>;
}

/**
 * Factory function to create storage instances
 */
export async function createKVStorage(config: KVStorageConfig): Promise<KVStorage> {
  switch (config.type) {
    case "deno-kv": {
      const { DenoKVStorage } = await import("./deno-kv-storage.ts");
      const storage = new DenoKVStorage(config.connection);
      await storage.initialize();
      return storage;
    }
    case "memory": {
      const { MemoryKVStorage } = await import("./memory-kv-storage.ts");
      const storage = new MemoryKVStorage();
      await storage.initialize();
      return storage;
    }
    default:
      throw new Error(`Unsupported storage type: ${config.type}`);
  }
}

/**
 * Storage error types for better error handling
 */
export class KVStorageError extends Error {
  public readonly code: string;
  public override readonly cause?: Error;

  constructor(
    message: string,
    code: string,
    cause?: Error,
  ) {
    super(message);
    this.name = "KVStorageError";
    this.code = code;
    this.cause = cause;
  }
}

export class KVTransactionError extends KVStorageError {
  constructor(message: string, cause?: Error) {
    super(message, "TRANSACTION_FAILED", cause);
    this.name = "KVTransactionError";
  }
}

export class KVConnectionError extends KVStorageError {
  constructor(message: string, cause?: Error) {
    super(message, "CONNECTION_FAILED", cause);
    this.name = "KVConnectionError";
  }
}

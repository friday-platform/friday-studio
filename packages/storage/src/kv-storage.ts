/**
 * Foundational Key-Value Storage Interface
 *
 * This interface provides a clean abstraction over key-value storage systems,
 * completely hiding implementation details like Deno.Kv types. All storage
 * adapters and business logic should use this interface instead of directly
 * accessing storage-specific APIs.
 */

import type { MaybePromise } from "@atlas/utils";
import type { NatsConnection } from "nats";
import { JetStreamKVStorage } from "./jetstream-kv-storage.ts";
import { MemoryKVStorage } from "./memory-kv-storage.ts";

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
  commit(): MaybePromise<boolean>;
}

/**
 * Entry returned by list operations
 */
export interface KVEntry<T, U extends readonly (string | number | bigint)[] = string[]> {
  key: U;
  value: T;
  versionstamp?: string; // Optional version for optimistic concurrency
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
  initialize(): MaybePromise<void>;

  /**
   * Get a value by key
   * @param key Hierarchical key path (e.g., ["workspaces", "abc123"])
   * @returns Value if found, null if not found
   */
  get<T>(key: string[]): MaybePromise<T | null>;

  /**
   * Set a key-value pair
   * @param key Hierarchical key path
   * @param value Value to store
   */
  set<T>(key: string[], value: T): MaybePromise<void>;

  /**
   * Delete a key
   * @param key Hierarchical key path
   */
  delete(key: string[]): MaybePromise<void>;

  /**
   * List all entries with a given key prefix
   * @param prefix Key prefix to match (e.g., ["workspaces"] matches all workspace keys)
   * @returns Async iterator of matching entries
   */
  list<T, U extends readonly (string | number | bigint)[] = string[]>(
    prefix: string[],
  ): AsyncIterableIterator<KVEntry<T, U>>;

  /**
   * Create an atomic operation for transactional consistency
   * @returns Atomic operation builder
   */
  atomic(): AtomicOperation;

  /**
   * Check if the storage system is healthy and accessible
   * @returns true if healthy, false otherwise
   */
  health(): MaybePromise<boolean>;

  /**
   * Close the storage connection and cleanup resources
   */
  close(): MaybePromise<void>;
}

/**
 * Storage configuration options. The `deno-kv` backend was removed in
 * the 2026-05-02 JetStream KV consolidation — use
 * `createJetStreamKVStorage` for production surfaces, and `memory` here
 * for tests.
 */
export interface KVStorageConfig {
  type: "memory";
  options?: Record<string, unknown>;
}

/** Factory function to create storage instances. */
export function createKVStorage(config: KVStorageConfig): Promise<KVStorage> {
  switch (config.type) {
    case "memory": {
      const storage = new MemoryKVStorage();
      storage.initialize();
      // @ts-expect-error issue with narrowing Deno.KVKey in the `*list` asyncIterator.
      return Promise.resolve(storage);
    }
    default:
      throw new Error(`Unsupported storage type: ${(config as { type: string }).type}`);
  }
}

/**
 * JetStream-KV–backed storage. Separate from `createKVStorage` because
 * it needs a live NATS connection at construction time — the pure
 * config-string factory above can't carry one. Daemon calls this
 * directly for surfaces that have moved to JetStream substrate (cron
 * timers as of 2026-05-02; workspace registry next).
 */
export async function createJetStreamKVStorage(
  nc: NatsConnection,
  options: { bucket: string; history?: number },
): Promise<KVStorage> {
  const storage = new JetStreamKVStorage(nc, options);
  await storage.initialize();
  return storage;
}

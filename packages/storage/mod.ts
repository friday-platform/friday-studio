/**
 * @module @atlas/storage
 *
 * Storage adapters and abstractions for Atlas
 *
 * This package provides:
 * - Storage interfaces and abstractions
 * - Various storage adapter implementations
 * - KV storage implementations
 * - Memory persistence utilities
 */

// TODO: Move from src/storage/
// TODO: Move from src/core/storage/

export const STORAGE_VERSION = "1.0.0";

// Placeholder interfaces - will be replaced as we migrate code
export interface StorageAdapter {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
}

export interface KVStorage {
  // TODO: Add KV storage interface
}

// Placeholder implementations
export class MemoryStorage implements StorageAdapter {
  private store = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    return this.store.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }
}

// TODO: Export actual implementations as we migrate:
// - LocalStorage
// - DenoKVStorage
// - LibraryStorageAdapter
// - RegistryStorageAdapter
// - etc.

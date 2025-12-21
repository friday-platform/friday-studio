/**
 * Atlas Storage Layer
 *
 * This module provides a clean layered storage architecture:
 *
 * 1. KVStorage - Foundational key-value interface
 * 2. Implementation adapters (DenoKVStorage, MemoryKVStorage, etc.)
 * 3. Domain-specific adapters (RegistryStorageAdapter, LibraryStorageAdapter)
 * 4. Business logic classes use domain adapters (never raw storage)
 *
 * This design ensures:
 * - Complete storage backend independence
 * - No leakage of implementation-specific types
 * - Swappable storage systems (KV, Redis, Postgres, etc.)
 * - Clean testing with mock adapters
 */

import { cwd, env } from "node:process";
import { createKVStorage, type KVStorageConfig } from "./kv-storage.ts";
import { LibraryStorageAdapter, type LibraryStorageConfig } from "./library-storage-adapter.ts";
import { RegistryStorageAdapter } from "./registry-storage-adapter.ts";

// Storage implementations
// Core interfaces;
export { createKVStorage } from "./kv-storage.ts";
// Domain-specific adapters
export { RegistryStorageAdapter } from "./registry-storage-adapter.ts";

// Factory functions for common configurations
export async function createRegistryStorage(
  config: KVStorageConfig,
): Promise<RegistryStorageAdapter> {
  const storage = await createKVStorage(config);
  const adapter = new RegistryStorageAdapter(storage);
  await adapter.initialize();
  return adapter;
}

export async function createLibraryStorage(
  kvConfig: KVStorageConfig,
  libraryConfig?: LibraryStorageConfig,
): Promise<LibraryStorageAdapter> {
  const storage = await createKVStorage(kvConfig);
  const adapter = new LibraryStorageAdapter(storage, libraryConfig);
  await adapter.initialize();
  return adapter;
}

// Common storage configurations
export const StorageConfigs = {
  /**
   * Default Deno KV storage in ~/.atlas/
   */
  defaultKV(): KVStorageConfig {
    const homeDir = env.HOME || env.USERPROFILE || cwd();
    return { type: "deno-kv", connection: `${homeDir}/.atlas/storage.db` };
  },

  /**
   * In-memory storage for testing
   */
  memory(): KVStorageConfig {
    return { type: "memory" };
  },

  /**
   * Custom Deno KV path
   */
  customKV(path: string): KVStorageConfig {
    return { type: "deno-kv", connection: path };
  },
} as const;

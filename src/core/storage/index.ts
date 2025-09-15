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

// Storage implementations
// Core interfaces;
export { createKVStorage } from "./kv-storage.ts";
// Domain-specific adapters
export { RegistryStorageAdapter } from "./registry-storage-adapter.ts";

// Factory functions for common configurations
export async function createRegistryStorage(
  config: import("./kv-storage.ts").KVStorageConfig,
): Promise<import("./registry-storage-adapter.ts").RegistryStorageAdapter> {
  const { createKVStorage } = await import("./kv-storage.ts");
  const storage = await createKVStorage(config);
  const { RegistryStorageAdapter } = await import("./registry-storage-adapter.ts");
  const adapter = new RegistryStorageAdapter(storage);
  await adapter.initialize();
  return adapter;
}

export async function createLibraryStorage(
  kvConfig: import("./kv-storage.ts").KVStorageConfig,
  libraryConfig?: import("./library-storage-adapter.ts").LibraryStorageConfig,
): Promise<import("./library-storage-adapter.ts").LibraryStorageAdapter> {
  const { createKVStorage } = await import("./kv-storage.ts");
  const storage = await createKVStorage(kvConfig);
  const { LibraryStorageAdapter } = await import("./library-storage-adapter.ts");
  const adapter = new LibraryStorageAdapter(storage, libraryConfig);
  await adapter.initialize();
  return adapter;
}

// Convenience function to create both registry and library storage
async function createAtlasStorage(
  kvConfig: import("./kv-storage.ts").KVStorageConfig,
  libraryConfig?: import("./library-storage-adapter.ts").LibraryStorageConfig,
): Promise<{
  registry: import("./registry-storage-adapter.ts").RegistryStorageAdapter;
  library: import("./library-storage-adapter.ts").LibraryStorageAdapter;
}> {
  const { createKVStorage } = await import("./kv-storage.ts");
  const storage = await createKVStorage(kvConfig);

  const { RegistryStorageAdapter } = await import("./registry-storage-adapter.ts");
  const { LibraryStorageAdapter } = await import("./library-storage-adapter.ts");

  const registry = new RegistryStorageAdapter(storage);
  const library = new LibraryStorageAdapter(storage, libraryConfig);

  await registry.initialize();
  await library.initialize();

  return { registry, library };
}

// Common storage configurations
export const StorageConfigs = {
  /**
   * Default Deno KV storage in ~/.atlas/
   */
  defaultKV(): import("./kv-storage.ts").KVStorageConfig {
    const homeDir = Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || Deno.cwd();
    return { type: "deno-kv", connection: `${homeDir}/.atlas/storage.db` };
  },

  /**
   * In-memory storage for testing
   */
  memory(): import("./kv-storage.ts").KVStorageConfig {
    return { type: "memory" };
  },

  /**
   * Custom Deno KV path
   */
  customKV(path: string): import("./kv-storage.ts").KVStorageConfig {
    return { type: "deno-kv", connection: path };
  },
} as const;

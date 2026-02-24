/**
 * Workspace Storage Barrel
 *
 * Factory functions and configurations for workspace storage adapters.
 * Registry adapter lives here (not in @atlas/storage) to avoid a
 * storage → workspace → storage cycle.
 */

import { cwd, env } from "node:process";
import { LibraryStorageAdapter, type LibraryStorageConfig } from "@atlas/storage";
import { createKVStorage, type KVStorageConfig } from "@atlas/storage/kv";
import { RegistryStorageAdapter } from "./registry-storage-adapter.ts";

export { createKVStorage } from "@atlas/storage/kv";
// Re-export for convenience
export { RegistryStorageAdapter } from "./registry-storage-adapter.ts";

/**
 * Create a registry storage adapter backed by KV storage.
 */
export async function createRegistryStorage(
  config: KVStorageConfig,
): Promise<RegistryStorageAdapter> {
  const storage = await createKVStorage(config);
  const adapter = new RegistryStorageAdapter(storage);
  await adapter.initialize();
  return adapter;
}

/**
 * Create a library storage adapter backed by KV storage.
 */
export async function createLibraryStorage(
  kvConfig: KVStorageConfig,
  libraryConfig?: LibraryStorageConfig,
): Promise<LibraryStorageAdapter> {
  const storage = await createKVStorage(kvConfig);
  const adapter = new LibraryStorageAdapter(storage, libraryConfig);
  await adapter.initialize();
  return adapter;
}

/** Common storage configurations */
export const StorageConfigs = {
  /** Default Deno KV storage in ~/.atlas/ */
  defaultKV(): KVStorageConfig {
    const homeDir = env.HOME || env.USERPROFILE || cwd();
    return { type: "deno-kv", connection: `${homeDir}/.atlas/storage.db` };
  },

  /** In-memory storage for testing */
  memory(): KVStorageConfig {
    return { type: "memory" };
  },

  /** Custom Deno KV path */
  customKV(path: string): KVStorageConfig {
    return { type: "deno-kv", connection: path };
  },
} as const;

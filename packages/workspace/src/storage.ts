/**
 * Workspace Storage Barrel
 *
 * Factory functions and configurations for workspace storage adapters.
 * Registry adapter lives here (not in @atlas/storage) to avoid a
 * storage → workspace → storage cycle.
 */

import { createKVStorage, type KVStorageConfig } from "@atlas/storage/kv";
import { getFridayHome } from "@atlas/utils/paths.server";
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

/** Common storage configurations */
export const StorageConfigs = {
  /** Default Deno KV storage in $FRIDAY_HOME/ (respects FRIDAY_HOME env var) */
  defaultKV(): KVStorageConfig {
    return { type: "deno-kv", connection: `${getFridayHome()}/storage.db` };
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

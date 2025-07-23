/**
 * Draft Factory - Factory functions for creating draft stores with different configurations
 */

import { createKVStorage, StorageConfigs } from "../../../../src/core/storage/index.ts";
import type { KVStorage, KVStorageConfig } from "../../../../src/core/storage/index.ts";
import { WorkspaceDraftStore } from "./storage.ts";

/**
 * Create a draft store with default KV storage
 */
export async function createDraftStore(): Promise<WorkspaceDraftStore> {
  const kvStorageConfig = StorageConfigs.defaultKV();
  const kvStorage = await createKVStorage(kvStorageConfig);
  const store = new WorkspaceDraftStore(kvStorage);
  await store.initialize();
  return store;
}

/**
 * Create a draft store with custom storage configuration
 */
export async function createDraftStoreWithConfig(
  config: KVStorageConfig,
): Promise<WorkspaceDraftStore> {
  const kvStorage = await createKVStorage(config);
  const store = new WorkspaceDraftStore(kvStorage);
  await store.initialize();
  return store;
}

/**
 * Create a draft store with existing KVStorage instance
 * Useful for dependency injection or testing scenarios
 */
export function createDraftStoreFromStorage(storage: KVStorage): WorkspaceDraftStore {
  return new WorkspaceDraftStore(storage);
}

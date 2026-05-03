/**
 * Workspace Storage Barrel
 *
 * Factory functions for workspace storage adapters. Registry adapter
 * lives here (not in @atlas/storage) to avoid a storage → workspace →
 * storage cycle.
 */

import { createJetStreamKVStorage, createKVStorage } from "@atlas/storage/kv";
import type { NatsConnection } from "nats";
import { RegistryStorageAdapter } from "./registry-storage-adapter.ts";

export { createJetStreamKVStorage, createKVStorage } from "@atlas/storage/kv";
// Re-export for convenience
export { RegistryStorageAdapter } from "./registry-storage-adapter.ts";

/**
 * Create a registry storage adapter backed by an in-memory KV. Tests
 * only — production goes through `createRegistryStorageJS`.
 */
export async function createRegistryStorageMemory(): Promise<RegistryStorageAdapter> {
  const storage = await createKVStorage({ type: "memory" });
  const adapter = new RegistryStorageAdapter(storage);
  await adapter.initialize();
  return adapter;
}

/**
 * Create a registry storage adapter backed by a JetStream KV bucket.
 * Daemon's primary path since 2026-05-02 — every workspace registry
 * write hits the broker, no local SQLite hop. Single-key model means
 * the JS KV per-key CAS is sufficient (the legacy multi-key
 * `_list`/`metadata` indices were dropped — see RegistryStorageAdapter
 * docstring).
 */
export async function createRegistryStorageJS(
  nc: NatsConnection,
  options: { bucket?: string; history?: number } = {},
): Promise<RegistryStorageAdapter> {
  const storage = await createJetStreamKVStorage(nc, {
    bucket: options.bucket ?? "WORKSPACE_REGISTRY",
    history: options.history ?? 5,
  });
  const adapter = new RegistryStorageAdapter(storage);
  await adapter.initialize();
  return adapter;
}

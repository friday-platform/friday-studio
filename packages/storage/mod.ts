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

// deno-lint-ignore no-empty-interface
export interface KVStorage {
  // TODO: Add KV storage interface
}

// Placeholder implementations
export class MemoryStorage implements StorageAdapter {
  private store = new Map<string, unknown>();

  get(key: string): Promise<unknown> {
    return Promise.resolve(this.store.get(key));
  }

  set(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  has(key: string): Promise<boolean> {
    return Promise.resolve(this.store.has(key));
  }
}

// Export configuration adapters
export type { ConfigurationAdapter } from "./src/adapters/config/mod.ts";
export { FilesystemConfigAdapter } from "./src/adapters/config/fs.ts";

// Export template adapters
export type {
  Template,
  TemplateInfo,
  TemplateStorageAdapter,
} from "./src/adapters/template-adapter.ts";
export { FilesystemTemplateAdapter } from "./src/adapters/filesystem-template-adapter.ts";

// Export workspace creation adapters
export type { WorkspaceCreationAdapter } from "./src/adapters/workspace-creation-adapter.ts";
export { FilesystemWorkspaceCreationAdapter } from "./src/adapters/workspace-creation-adapter.ts";

// TODO: Export actual implementations as we migrate:
// - LocalStorage
// - DenoKVStorage
// - LibraryStorageAdapter
// - RegistryStorageAdapter
// - etc.

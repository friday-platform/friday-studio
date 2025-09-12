/**
 * @module @atlas/storage
 *
 * Storage adapters and abstractions for Atlas
 *
 * This package provides:
 * - Storage interfaces and abstractions
 * - Various storage adapter implementations
 * - Memory persistence utilities
 * - Vector search storage adapters
 * - Knowledge graph storage adapters
 */

export const STORAGE_VERSION = "1.0.0";

// Knowledge graph storage adapters
export { KnowledgeGraphLocalStorageAdapter } from "./src/knowledge-graph/knowledge-graph-local.ts";
// Memory storage adapters
export { CoALALocalFileStorageAdapter } from "./src/memory/coala-local.ts";
export { FileWriteCoordinator } from "./src/memory/file-write-coordinator.ts";
export { InMemoryStorageAdapter } from "./src/memory/in-memory.ts";
// Core storage interfaces and types
export type {
  ICoALAMemoryStorageAdapter,
  IKnowledgeGraphStorageAdapter,
  KnowledgeEntity,
  KnowledgeFact,
  KnowledgeGraphQuery,
  KnowledgeRelationship,
} from "./src/types/core.ts";

// Export enums as values (not types)
export {
  KnowledgeEntityType,
  KnowledgeRelationType,
} from "./src/types/core.ts";
// Vector search interfaces
export type {
  IEmbeddingProvider,
  IVectorSearchStorageAdapter,
  VectorEmbedding,
  VectorIndexStats,
  VectorSearchConfig,
  VectorSearchQuery,
  VectorSearchResult,
} from "./src/types/vector-search.ts";
// Vector search storage adapters
export { VectorSearchLocalStorageAdapter } from "./src/vector/vector-search-local.ts";

// General storage interface
export interface StorageAdapter {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
}

// Simple in-memory storage implementation
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

export { FilesystemConfigAdapter } from "./src/adapters/config/fs.ts";
// Export configuration adapters
export type { ConfigurationAdapter } from "./src/adapters/config/mod.ts";
export { FilesystemTemplateAdapter } from "./src/adapters/filesystem-template-adapter.ts";
// Export template adapters
export type {
  Template,
  TemplateInfo,
  TemplateStorageAdapter,
} from "./src/adapters/template-adapter.ts";

// Export workspace creation adapters
export type { WorkspaceCreationAdapter } from "./src/adapters/workspace-creation-adapter.ts";
export { FilesystemWorkspaceCreationAdapter } from "./src/adapters/workspace-creation-adapter.ts";

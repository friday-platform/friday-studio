/**
 * @module @atlas/document-store
 *
 * Schema-validated document storage for Atlas workspaces
 *
 * This package provides:
 * - Simple CRUD operations for documents
 * - Zod schema validation
 * - Workspace and session scoping
 * - Filesystem-based storage
 * - In-memory storage for testing
 */

export { DocumentStore } from "./src/document-store.ts";
// Backward compatibility alias
export type { FileSystemDocumentStoreOptions as DocumentStoreOptions } from "./src/file-system-document-store.ts";
export {
  FileSystemDocumentStore,
  type FileSystemDocumentStoreOptions,
} from "./src/file-system-document-store.ts";
export { InMemoryDocumentStore } from "./src/in-memory-document-store.ts";
export { JetStreamDocumentStore } from "./src/jetstream-document-store.ts";
export {
  getDocumentStore,
  initDocumentStore,
  setDocumentStoreForTest,
} from "./src/storage.ts";
export type { DocumentScope, StoredDocument } from "./src/types.ts";

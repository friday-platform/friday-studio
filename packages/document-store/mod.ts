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

export const DOCUMENT_STORE_VERSION = "1.0.0";

export { DocumentStore } from "./src/document-store.ts";
// Backward compatibility alias
export type { FileSystemDocumentStoreOptions as DocumentStoreOptions } from "./src/file-system-document-store.ts";
export {
  FileSystemDocumentStore,
  type FileSystemDocumentStoreOptions,
} from "./src/file-system-document-store.ts";
export { InMemoryDocumentStore } from "./src/in-memory-document-store.ts";
export type { DocumentScope, StoredDocument } from "./src/types.ts";

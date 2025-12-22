/**
 * @module @atlas/document-store/node
 *
 * Node.js-compatible exports (excludes Deno-specific FileSystemDocumentStore)
 *
 * For Node.js environments (like evalite), import from this file:
 * ```
 * import { InMemoryDocumentStore } from "../document-store/node.ts";
 * ```
 */

export const DOCUMENT_STORE_VERSION = "1.0.0";

export { DocumentStore } from "./src/document-store.ts";
export { InMemoryDocumentStore } from "./src/in-memory-document-store.ts";
export type { DocumentScope, StoredDocument } from "./src/types.ts";

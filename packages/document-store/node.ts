/**
 * @module @atlas/document-store/node
 *
 * Node.js-compatible exports (excludes Deno-specific FileSystemDocumentStore)
 *
 * For Node.js environments, import from this file:
 * ```
 * import { InMemoryDocumentStore } from "../document-store/node.ts";
 * ```
 */

export { DocumentStore } from "./src/document-store.ts";
export { InMemoryDocumentStore } from "./src/in-memory-document-store.ts";
export type { DocumentScope, StoredDocument } from "./src/types.ts";

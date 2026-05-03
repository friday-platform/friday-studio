/**
 * @module @atlas/document-store/node
 *
 * Node.js-compatible re-exports. Kept as a separate entry point for
 * historical reasons; the same exports live on the main `mod.ts`.
 */

export { DocumentStore } from "./src/document-store.ts";
export { JetStreamDocumentStore } from "./src/jetstream-document-store.ts";
export { getDocumentStore } from "./src/storage.ts";
export type { DocumentScope, StoredDocument } from "./src/types.ts";

/**
 * @module @atlas/document-store
 *
 * Schema-validated document storage for Atlas workspaces.
 *
 * Production wires `JetStreamDocumentStore` via `initDocumentStore(nc)`
 * at daemon startup. NATS is a hard requirement — there is no
 * in-process / on-disk fallback. Tests stand up a NATS test server
 * (see vitest.setup.ts) and let the same JetStream adapter run
 * against it.
 */

export { DocumentStore } from "./src/document-store.ts";
export { JetStreamDocumentStore } from "./src/jetstream-document-store.ts";
export { getDocumentStore, initDocumentStore, setDocumentStoreForTest } from "./src/storage.ts";
export type { DocumentScope, StoredDocument } from "./src/types.ts";

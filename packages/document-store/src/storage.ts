/**
 * DocumentStore singleton facade.
 *
 * Daemon calls `initDocumentStore(nc)` at startup, then any code that
 * needs a DocumentStore (workspace runtime, FSM engine, MCP-tool runner)
 * calls `getDocumentStore()`.
 *
 * Tests that don't need real persistence can call
 * `setDocumentStoreForTest(new InMemoryDocumentStore())`.
 */

import type { NatsConnection } from "nats";
import type { DocumentStore } from "./document-store.ts";
import { JetStreamDocumentStore } from "./jetstream-document-store.ts";

let _store: DocumentStore | null = null;

/** Wire production DocumentStore (JetStream-backed) at daemon startup. */
export function initDocumentStore(nc: NatsConnection): void {
  _store = new JetStreamDocumentStore(nc);
}

/**
 * Return the current DocumentStore. Throws if init was never called —
 * a missing init is a daemon-wiring bug; falling back to an in-memory
 * store would silently lose every FSM document on restart, which is
 * worse than failing fast. Tests that exercise this path without a
 * real NATS server should call `setDocumentStoreForTest(new
 * InMemoryDocumentStore())` explicitly.
 */
export function getDocumentStore(): DocumentStore {
  if (!_store) {
    throw new Error(
      "DocumentStore not initialized — call initDocumentStore(nc) at daemon startup, " +
        "or setDocumentStoreForTest(new InMemoryDocumentStore()) in tests.",
    );
  }
  return _store;
}

/** Inject a custom adapter — tests only. */
export function setDocumentStoreForTest(store: DocumentStore | null): void {
  _store = store;
}

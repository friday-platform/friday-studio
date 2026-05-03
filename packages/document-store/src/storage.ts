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

import { logger } from "@atlas/logger";
import type { NatsConnection } from "nats";
import type { DocumentStore } from "./document-store.ts";
import { InMemoryDocumentStore } from "./in-memory-document-store.ts";
import { JetStreamDocumentStore } from "./jetstream-document-store.ts";

let _store: DocumentStore | null = null;

/** Wire production DocumentStore (JetStream-backed) at daemon startup. */
export function initDocumentStore(nc: NatsConnection): void {
  _store = new JetStreamDocumentStore(nc);
}

/**
 * Return the current DocumentStore. Falls back to an in-memory store
 * if neither `initDocumentStore(nc)` nor `setDocumentStoreForTest()`
 * has been called — that path is intended for unit tests that exercise
 * the workspace runtime without standing up a real NATS server. Logs
 * a warning so production wiring bugs don't go silent.
 */
export function getDocumentStore(): DocumentStore {
  if (!_store) {
    logger.warn(
      "DocumentStore not initialized — falling back to InMemoryDocumentStore. " +
        "If you're seeing this in production, call initDocumentStore(nc) at daemon startup.",
    );
    _store = new InMemoryDocumentStore();
  }
  return _store;
}

/** Inject a custom adapter — tests only. */
export function setDocumentStoreForTest(store: DocumentStore | null): void {
  _store = store;
}

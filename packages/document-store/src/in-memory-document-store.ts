/**
 * In-memory implementation of DocumentStore
 * Useful for testing and non-persistent environments
 */

import { DocumentStore } from "./document-store.ts";
import type { DocumentScope, StoredDocument } from "./types.ts";

export class InMemoryDocumentStore extends DocumentStore {
  private store = new Map<string, StoredDocument>();
  private stateStore = new Map<string, unknown>();

  private buildKey(scope: DocumentScope, type: string, id: string): string {
    return `${scope.workspaceId}::${scope.sessionId || ""}::${type}::${id}`;
  }

  private buildStateKey(scope: DocumentScope, key: string): string {
    return `${scope.workspaceId}::${scope.sessionId || ""}::state::${key}`;
  }

  delete(scope: DocumentScope, type: string, id: string): Promise<boolean> {
    const key = this.buildKey(scope, type, id);
    return Promise.resolve(this.store.delete(key));
  }

  exists(scope: DocumentScope, type: string, id: string): Promise<boolean> {
    const key = this.buildKey(scope, type, id);
    return Promise.resolve(this.store.has(key));
  }

  list(scope: DocumentScope, type: string): Promise<string[]> {
    const prefix = `${scope.workspaceId}::${scope.sessionId || ""}::${type}::`;
    const ids: string[] = [];

    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        // Extract ID: prefix is "workspace::session::type::", remainder is id
        ids.push(key.substring(prefix.length));
      }
    }
    return Promise.resolve(ids);
  }

  protected readRaw(scope: DocumentScope, type: string, id: string): Promise<unknown | null> {
    const key = this.buildKey(scope, type, id);
    const doc = this.store.get(key);
    // Return a clone to mimic filesystem isolation (prevent mutation of stored object)
    if (!doc) return Promise.resolve(null);
    return Promise.resolve(structuredClone(doc));
  }

  protected writeRaw(
    scope: DocumentScope,
    type: string,
    id: string,
    doc: StoredDocument,
  ): Promise<void> {
    const key = this.buildKey(scope, type, id);
    // Store a clone
    this.store.set(key, structuredClone(doc));
    return Promise.resolve();
  }

  /**
   * Debug utility to clear the store
   */
  clear(): void {
    this.store.clear();
    this.stateStore.clear();
  }

  protected saveStateRaw(scope: DocumentScope, key: string, state: unknown): Promise<void> {
    const storeKey = this.buildStateKey(scope, key);
    this.stateStore.set(storeKey, structuredClone(state));
    return Promise.resolve();
  }

  protected loadStateRaw(scope: DocumentScope, key: string): Promise<unknown | null> {
    const storeKey = this.buildStateKey(scope, key);
    const state = this.stateStore.get(storeKey);
    if (state === undefined) return Promise.resolve(null);
    return Promise.resolve(structuredClone(state));
  }
}

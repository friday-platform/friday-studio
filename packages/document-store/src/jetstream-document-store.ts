/**
 * JetStream KV–backed `DocumentStore`.
 *
 * Replaces `FileSystemDocumentStore` (per-workspace JSON files under
 * `~/.atlas/workspaces/<wsid>/[sessions/<sid>/]<type>/<id>.json`).
 *
 * **Layout** — one KV bucket per workspace, `WS_DOCS_<sanitized_wsid>`,
 * with hierarchical keys mapped onto JS KV's flat keyspace by the
 * existing `JetStreamKVStorage` (which encodes `:` / spaces / etc):
 *
 *   ["doc",   <type>, <id>]                      — workspace-scoped doc
 *   ["doc",   "session", <sid>, <type>, <id>]    — session-scoped doc
 *   ["state", <key>]                             — workspace-scoped state
 *   ["state", "session", <sid>, <key>]           — session-scoped state
 *
 * Per-workspace bucket so `js.kv.delete(WS_DOCS_<wsid>)` is the whole
 * workspace teardown — no global scan-and-prune.
 *
 * Bucket creation is lazy + cached per workspaceId. The lookup map
 * holds a `Promise<KVStorage>` to avoid double-init on parallel
 * first-touches.
 */

import { createJetStreamKVStorage, type KVStorage } from "@atlas/storage";
import type { NatsConnection } from "nats";
import { DocumentStore } from "./document-store.ts";
import type { DocumentScope, StoredDocument } from "./types.ts";

const SAFE_BUCKET_RE = /[^A-Za-z0-9_-]/g;

function sanitizeBucketName(workspaceId: string): string {
  return workspaceId.replace(SAFE_BUCKET_RE, "_");
}

export class JetStreamDocumentStore extends DocumentStore {
  private readonly buckets = new Map<string, Promise<KVStorage>>();

  constructor(private readonly nc: NatsConnection) {
    super();
  }

  private getKV(workspaceId: string): Promise<KVStorage> {
    const sanitized = sanitizeBucketName(workspaceId);
    const cached = this.buckets.get(sanitized);
    if (cached) return cached;
    const created = createJetStreamKVStorage(this.nc, {
      bucket: `WS_DOCS_${sanitized}`,
      history: 1,
    });
    this.buckets.set(sanitized, created);
    return created;
  }

  private docKey(scope: DocumentScope, type: string, id: string): string[] {
    if (scope.sessionId) return ["doc", "session", scope.sessionId, type, id];
    return ["doc", type, id];
  }

  private docListPrefix(scope: DocumentScope, type: string): string[] {
    if (scope.sessionId) return ["doc", "session", scope.sessionId, type];
    return ["doc", type];
  }

  private stateKey(scope: DocumentScope, key: string): string[] {
    if (scope.sessionId) return ["state", "session", scope.sessionId, key];
    return ["state", key];
  }

  async delete(scope: DocumentScope, type: string, id: string): Promise<boolean> {
    const kv = await this.getKV(scope.workspaceId);
    const key = this.docKey(scope, type, id);
    const existing = await kv.get(key);
    if (existing === null) return false;
    await kv.delete(key);
    this.logger.debug("Document deleted", {
      type,
      id,
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
    });
    return true;
  }

  async exists(scope: DocumentScope, type: string, id: string): Promise<boolean> {
    const kv = await this.getKV(scope.workspaceId);
    const value = await kv.get(this.docKey(scope, type, id));
    return value !== null;
  }

  async list(scope: DocumentScope, type: string): Promise<string[]> {
    const kv = await this.getKV(scope.workspaceId);
    const ids: string[] = [];
    const prefix = this.docListPrefix(scope, type);
    for await (const e of kv.list<unknown>(prefix)) {
      const last = e.key[e.key.length - 1];
      if (typeof last === "string") ids.push(last);
    }
    return ids;
  }

  protected async readRaw(scope: DocumentScope, type: string, id: string): Promise<unknown | null> {
    const kv = await this.getKV(scope.workspaceId);
    return await kv.get(this.docKey(scope, type, id));
  }

  protected async writeRaw(
    scope: DocumentScope,
    type: string,
    id: string,
    doc: StoredDocument,
  ): Promise<void> {
    const kv = await this.getKV(scope.workspaceId);
    await kv.set(this.docKey(scope, type, id), doc);
    this.logger.debug("Document written to JetStream", {
      type,
      id,
      workspaceId: scope.workspaceId,
      sessionId: scope.sessionId,
    });
  }

  protected async saveStateRaw(scope: DocumentScope, key: string, state: unknown): Promise<void> {
    const kv = await this.getKV(scope.workspaceId);
    await kv.set(this.stateKey(scope, key), state);
  }

  protected async loadStateRaw(scope: DocumentScope, key: string): Promise<unknown | null> {
    const kv = await this.getKV(scope.workspaceId);
    return await kv.get(this.stateKey(scope, key));
  }
}

/**
 * JetStream-backed MemoryAdapter facade.
 *
 * Hands out JetStreamNarrativeStore handles. Narrative metadata lives in
 * the MEMORY_INDEX KV bucket; entries live in per-narrative streams.
 */

import type {
  HistoryEntry,
  HistoryFilter,
  MemoryAdapter,
  NarrativeStore,
  StoreMetadata,
} from "@atlas/agent-sdk";
import type { NatsConnection } from "nats";
import {
  ensureMemoryIndexBucket,
  JetStreamNarrativeStore,
  type MemoryStreamLimits,
  type NarrativeIndexEntry,
  NarrativeIndexEntrySchema,
} from "./js-narrative-store.ts";
import { NotImplementedError } from "./md-skill-adapter.ts";

const dec = new TextDecoder();

export class JetStreamMemoryAdapter implements MemoryAdapter {
  private readonly nc: NatsConnection;
  private readonly limits: MemoryStreamLimits;

  constructor(opts: { nc: NatsConnection; limits?: MemoryStreamLimits }) {
    this.nc = opts.nc;
    this.limits = opts.limits ?? {};
  }

  /**
   * Idempotent — KV CAS upserts the metadata entry when first written by
   * append(). Calling ensureRoot pre-warms it so list() sees the entry
   * even before any append happens.
   */
  async ensureRoot(workspaceId: string, name: string): Promise<void> {
    const kv = await ensureMemoryIndexBucket(this.nc);
    const key = `${workspaceId}/${name}`;
    const existing = await kv.get(key);
    if (existing && existing.operation === "PUT") return;
    const enc = new TextEncoder();
    const meta: NarrativeIndexEntry = {
      workspaceId,
      name,
      entryCount: 0,
      lastUpdated: new Date().toISOString(),
      tombstones: [],
    };
    try {
      await kv.create(key, enc.encode(JSON.stringify(meta)));
    } catch {
      // Lost the race to another writer — fine, the entry now exists.
    }
  }

  store(workspaceId: string, name: string): Promise<NarrativeStore> {
    return Promise.resolve(
      new JetStreamNarrativeStore({ nc: this.nc, workspaceId, name, limits: this.limits }),
    );
  }

  async list(workspaceId: string): Promise<StoreMetadata[]> {
    const kv = await ensureMemoryIndexBucket(this.nc);
    const it = await kv.keys();
    const prefix = `${workspaceId}/`;
    const matched: string[] = [];
    for await (const key of it) {
      if (key.startsWith(prefix)) matched.push(key);
    }
    const results: StoreMetadata[] = [];
    for (const key of matched) {
      const entry = await kv.get(key);
      if (!entry || entry.operation !== "PUT") continue;
      try {
        const parsed = NarrativeIndexEntrySchema.parse(JSON.parse(dec.decode(entry.value)));
        results.push({ name: parsed.name, kind: "narrative", workspaceId: parsed.workspaceId });
      } catch {
        // Skip malformed entries
      }
    }
    return results;
  }

  async bootstrap(workspaceId: string, _agentId: string): Promise<string> {
    const stores = await this.list(workspaceId);
    if (stores.length === 0) return "";
    const rendered: string[] = [];
    for (const meta of stores) {
      const store = await this.store(workspaceId, meta.name);
      const content = await store.render();
      if (content.trim().length > 0) rendered.push(content);
    }
    return rendered.join("\n");
  }

  history(_workspaceId: string, _filter?: HistoryFilter): Promise<HistoryEntry[]> {
    throw new NotImplementedError("history() not implemented");
  }

  rollback(_workspaceId: string, _store: string, _toVersion: string): Promise<void> {
    throw new NotImplementedError("rollback() not implemented");
  }
}

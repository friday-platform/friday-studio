/**
 * JetStream-KV–backed MCP registry adapter.
 *
 * Replaces LocalMCPRegistryAdapter (Deno KV at `~/.atlas/mcp-registry.db`).
 * One bucket: `MCP_REGISTRY`, key = entry id, value = MCPServerMetadata
 * JSON. Atomic operations (add/update) use JS KV CAS via `revision`.
 *
 * Mapping notes (Deno KV → JetStream KV):
 * - `kv.atomic().check({key, versionstamp: null}).set(...)` (add-if-absent)
 *   → `kv.create(key, value)` which fails if the key exists.
 * - `kv.atomic().check(existing).set(key, updated)` (CAS update)
 *   → `kv.update(key, value, existing.revision)` which fails on revision
 *   mismatch.
 * - `kv.list({prefix})` (range scan)
 *   → collect all keys via `kv.keys()`, then per-key `kv.get`. Acceptable
 *   at MCP-registry cardinality (dozens to low hundreds of servers).
 */

import { createJetStreamFacade, dec, enc, isCASConflict } from "jetstream";
import type { KV, NatsConnection } from "nats";
import type { MCPServerMetadata } from "../schemas.ts";
import type { MCPRegistryStorageAdapter, UpdatableMCPServerMetadata } from "./adapter.ts";

export const MCP_REGISTRY_BUCKET = "MCP_REGISTRY";

export class JetStreamMCPRegistryAdapter implements MCPRegistryStorageAdapter {
  private cachedKv: KV | null = null;

  constructor(private readonly nc: NatsConnection) {}

  private async kv(): Promise<KV> {
    if (this.cachedKv) return this.cachedKv;
    const facade = createJetStreamFacade(this.nc);
    // history: 5 → cheap audit trail of who-changed-what within the
    // last 5 revisions. Enough to debug the "X just got updated, what
    // was its previous shape" question without unbounded growth.
    this.cachedKv = await facade.kv.getOrCreate(MCP_REGISTRY_BUCKET, { history: 5 });
    return this.cachedKv;
  }

  async add(entry: MCPServerMetadata): Promise<void> {
    const kv = await this.kv();
    try {
      await kv.create(entry.id, enc.encode(JSON.stringify(entry)));
    } catch (err) {
      // create() throws on conflict (key exists) or any other error.
      // Distinguish "already exists" from genuine errors so callers
      // get the same error shape they got from the Deno KV adapter.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("wrong last sequence") || msg.includes("exists")) {
        throw new Error(`Entry already exists: ${entry.id}`);
      }
      throw err;
    }
  }

  async get(id: string): Promise<MCPServerMetadata | null> {
    const kv = await this.kv();
    const entry = await kv.get(id);
    if (!entry || entry.operation !== "PUT") return null;
    return JSON.parse(dec.decode(entry.value)) as MCPServerMetadata;
  }

  async list(): Promise<MCPServerMetadata[]> {
    const kv = await this.kv();
    // Collect keys first, THEN read values — the kv.keys() iterator
    // can't be interleaved with kv.get() calls without truncation.
    const it = await kv.keys();
    const keys: string[] = [];
    for await (const k of it) keys.push(k);
    const out: MCPServerMetadata[] = [];
    for (const key of keys) {
      const entry = await kv.get(key);
      if (!entry || entry.operation !== "PUT") continue;
      try {
        out.push(JSON.parse(dec.decode(entry.value)) as MCPServerMetadata);
      } catch {
        // Skip malformed entries — operator can clean up via `nats kv del`.
      }
    }
    return out;
  }

  async delete(id: string): Promise<boolean> {
    const kv = await this.kv();
    const existing = await kv.get(id);
    if (!existing || existing.operation !== "PUT") return false;
    await kv.delete(id);
    return true;
  }

  async update(
    id: string,
    changes: Partial<UpdatableMCPServerMetadata>,
  ): Promise<MCPServerMetadata | null> {
    const kv = await this.kv();
    const existing = await kv.get(id);
    if (!existing || existing.operation !== "PUT") return null;
    const current = JSON.parse(dec.decode(existing.value)) as MCPServerMetadata;
    const updated: MCPServerMetadata = { ...current, ...changes };
    try {
      await kv.update(id, enc.encode(JSON.stringify(updated)), existing.revision);
    } catch (err) {
      if (isCASConflict(err)) {
        throw new Error(`Concurrent modification detected for entry: ${id}`);
      }
      throw err;
    }
    return updated;
  }
}

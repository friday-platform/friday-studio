import type { MCPServerMetadata } from "../schemas.ts";
import type { MCPRegistryStorageAdapter, UpdatableMCPServerMetadata } from "./adapter.ts";

const KV_PREFIX = ["mcp_registry"] as const;

export class LocalMCPRegistryAdapter implements MCPRegistryStorageAdapter {
  constructor(private kv: Deno.Kv) {}

  async add(entry: MCPServerMetadata): Promise<void> {
    const key = [...KV_PREFIX, entry.id];

    const result = await this.kv
      .atomic()
      .check({ key, versionstamp: null }) // Only succeed if key doesn't exist
      .set(key, entry)
      .commit();

    if (!result.ok) {
      throw new Error(`Entry already exists: ${entry.id}`);
    }
  }

  async get(id: string): Promise<MCPServerMetadata | null> {
    const result = await this.kv.get<MCPServerMetadata>([...KV_PREFIX, id]);
    return result.value;
  }

  async list(): Promise<MCPServerMetadata[]> {
    const entries: MCPServerMetadata[] = [];
    for await (const entry of this.kv.list<MCPServerMetadata>({ prefix: [...KV_PREFIX] })) {
      entries.push(entry.value);
    }
    return entries;
  }

  async delete(id: string): Promise<boolean> {
    const key = [...KV_PREFIX, id];
    const existing = await this.kv.get(key);
    if (existing.value === null) return false;
    const result = await this.kv.atomic().check(existing).delete(key).commit();
    return result.ok;
  }

  async update(
    id: string,
    changes: Partial<UpdatableMCPServerMetadata>,
  ): Promise<MCPServerMetadata | null> {
    const key = [...KV_PREFIX, id];

    // Read current entry with versionstamp for atomic check
    const existing = await this.kv.get<MCPServerMetadata>(key);
    if (existing.value === null) {
      return null;
    }

    // Merge changes into existing entry
    const updated: MCPServerMetadata = { ...existing.value, ...changes };

    // Atomic update: check versionstamp hasn't changed, then set new value
    const result = await this.kv.atomic().check(existing).set(key, updated).commit();

    if (!result.ok) {
      throw new Error(`Concurrent modification detected for entry: ${id}`);
    }

    return updated;
  }
}

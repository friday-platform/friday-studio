import type { MCPServerMetadata } from "../schemas.ts";
import type { MCPRegistryStorageAdapter } from "./adapter.ts";

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
}

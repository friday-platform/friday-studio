import type { DynamicProviderInput } from "../types.ts";
import type { ProviderStorageAdapter } from "./adapter.ts";

const KV_PREFIX = ["providers"] as const;

/**
 * Local Deno KV-based provider storage adapter.
 *
 * Used for development and single-container deployments.
 * Stores dynamic provider definitions in a local SQLite-backed KV store.
 *
 * Key structure: ["providers", providerId]
 */
export class LocalProviderStorageAdapter implements ProviderStorageAdapter {
  constructor(private kv: Deno.Kv) {}

  async add(provider: DynamicProviderInput): Promise<void> {
    const key = [...KV_PREFIX, provider.id];

    const result = await this.kv
      .atomic()
      .check({ key, versionstamp: null }) // Only succeed if key doesn't exist
      .set(key, provider)
      .commit();

    if (!result.ok) {
      throw new Error(`Provider already exists: ${provider.id}`);
    }
  }

  async get(id: string): Promise<DynamicProviderInput | null> {
    const result = await this.kv.get<DynamicProviderInput>([...KV_PREFIX, id]);
    return result.value;
  }

  async list(): Promise<DynamicProviderInput[]> {
    const providers: DynamicProviderInput[] = [];
    for await (const entry of this.kv.list<DynamicProviderInput>({ prefix: [...KV_PREFIX] })) {
      providers.push(entry.value);
    }
    return providers;
  }

  async delete(id: string): Promise<boolean> {
    const key = [...KV_PREFIX, id];
    const existing = await this.kv.get(key);
    if (existing.value === null) return false;
    const result = await this.kv.atomic().check(existing).delete(key).commit();
    return result.ok;
  }
}

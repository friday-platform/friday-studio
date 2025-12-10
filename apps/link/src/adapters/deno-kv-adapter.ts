import type { Credential, CredentialSummary, StorageAdapter } from "../types.ts";

/**
 * DenoKV-based storage adapter with tenant isolation.
 * Key structure: ["credentials", userId, credentialId]
 */
export class DenoKVStorageAdapter implements StorageAdapter {
  constructor(private kvPath: string) {}

  // private kvPath = join(getAtlasHome(), "dev_credentials.db");
  async save(credential: Credential, userId: string): Promise<void> {
    using kv = await Deno.openKv(this.kvPath);
    await kv.set(["credentials", userId, credential.id], credential);
  }

  async get(id: string, userId: string): Promise<Credential | null> {
    using kv = await Deno.openKv(this.kvPath);
    const entry = await kv.get<Credential>(["credentials", userId, id]);
    return entry.value;
  }

  async list(type: string, userId: string): Promise<CredentialSummary[]> {
    using kv = await Deno.openKv(this.kvPath);
    const summaries: CredentialSummary[] = [];
    for await (const entry of kv.list<Credential>({ prefix: ["credentials", userId] })) {
      if (entry.value.type === type) {
        const { secret: _, ...summary } = entry.value;
        summaries.push(summary);
      }
    }
    return summaries;
  }

  async delete(id: string, userId: string): Promise<void> {
    using kv = await Deno.openKv(this.kvPath);
    await kv.delete(["credentials", userId, id]);
  }
}

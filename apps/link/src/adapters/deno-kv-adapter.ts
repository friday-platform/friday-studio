import { openKv } from "@atlas/core/kv";
import { nanoid } from "nanoid";
import type {
  Credential,
  CredentialInput,
  CredentialSummary,
  Metadata,
  SaveResult,
  StorageAdapter,
} from "../types.ts";

/**
 * DenoKV-based storage adapter with tenant isolation.
 * Key structure: ["credentials", userId, credentialId]
 */
export class DenoKVStorageAdapter implements StorageAdapter {
  constructor(private kvPath: string) {}

  async save(input: CredentialInput, userId: string): Promise<SaveResult> {
    const id = nanoid();
    const now = new Date().toISOString();
    const metadata: Metadata = { createdAt: now, updatedAt: now };
    const credential: Credential = { ...input, id, metadata };
    using kv = await openKv(this.kvPath);
    await kv.set(["credentials", userId, id], credential);
    return { id, metadata };
  }

  async upsert(input: CredentialInput, userId: string): Promise<SaveResult> {
    using kv = await openKv(this.kvPath);

    // Find existing credential with same provider+label
    let existingId: string | null = null;
    let existingMetadata: Metadata | null = null;

    for await (const entry of kv.list<Credential>({ prefix: ["credentials", userId] })) {
      if (entry.value.provider === input.provider && entry.value.label === input.label) {
        existingId = entry.value.id;
        existingMetadata = entry.value.metadata;
        break;
      }
    }

    const now = new Date().toISOString();

    if (existingId && existingMetadata) {
      // Update existing
      const metadata: Metadata = { createdAt: existingMetadata.createdAt, updatedAt: now };
      const credential: Credential = { ...input, id: existingId, metadata };
      await kv.set(["credentials", userId, existingId], credential);
      return { id: existingId, metadata };
    }

    // Create new
    const id = nanoid();
    const metadata: Metadata = { createdAt: now, updatedAt: now };
    const credential: Credential = { ...input, id, metadata };
    await kv.set(["credentials", userId, id], credential);
    return { id, metadata };
  }

  async update(id: string, input: CredentialInput, userId: string): Promise<Metadata> {
    using kv = await openKv(this.kvPath);
    const existing = await kv.get<Credential>(["credentials", userId, id]);
    if (!existing.value) {
      throw new Error("Credential not found");
    }
    const now = new Date().toISOString();
    const metadata: Metadata = { createdAt: existing.value.metadata.createdAt, updatedAt: now };
    const credential: Credential = { ...input, id, metadata };
    await kv.set(["credentials", userId, id], credential);
    return metadata;
  }

  async get(id: string, userId: string): Promise<Credential | null> {
    using kv = await openKv(this.kvPath);
    const entry = await kv.get<Credential>(["credentials", userId, id]);
    return entry.value;
  }

  async list(type: string, userId: string): Promise<CredentialSummary[]> {
    using kv = await openKv(this.kvPath);
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
    using kv = await openKv(this.kvPath);
    await kv.delete(["credentials", userId, id]);
  }

  async findByProviderAndExternalId(
    provider: string,
    externalId: string,
    userId: string,
  ): Promise<Credential | null> {
    using kv = await openKv(this.kvPath);
    // List all credentials for user, filter by provider + externalId
    for await (const entry of kv.list<Credential>({ prefix: ["credentials", userId] })) {
      const cred = entry.value;
      if (
        cred.provider === provider &&
        typeof cred.secret.externalId === "string" &&
        cred.secret.externalId === externalId
      ) {
        return cred;
      }
    }
    return null;
  }
}

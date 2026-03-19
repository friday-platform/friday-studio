import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { nanoid } from "nanoid";
import type {
  Credential,
  CredentialInput,
  CredentialSummary,
  Metadata,
  SaveResult,
  StorageAdapter,
} from "../types.ts";
import { CredentialSchema } from "../types.ts";

/**
 * Filesystem-based storage adapter with tenant isolation.
 * Directory structure: <basePath>/<userId>/<credentialId>.json
 *
 * For local development use - concurrent write safety and high-throughput
 * performance are not critical requirements.
 */
export class FileSystemStorageAdapter implements StorageAdapter {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath ?? join(getAtlasHome(), "credentials");
  }

  async save(input: CredentialInput, userId: string): Promise<SaveResult> {
    const id = nanoid();
    const now = new Date().toISOString();
    const existing = await this.getAllForUser(userId);
    const isDefault = !existing.some((c) => c.provider === input.provider);
    const metadata: Metadata = { createdAt: now, updatedAt: now };
    const credential: Credential = { ...input, id, isDefault, metadata };

    const userDir = join(this.basePath, userId);
    await mkdir(userDir, { recursive: true });

    const filePath = join(userDir, `${id}.json`);
    await writeFile(filePath, JSON.stringify(credential, null, 2));

    return { id, isDefault, metadata };
  }

  async get(id: string, userId: string): Promise<Credential | null> {
    const filePath = join(this.basePath, userId, `${id}.json`);
    try {
      const content = await readFile(filePath, "utf-8");
      return CredentialSchema.parse(JSON.parse(content));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async update(id: string, input: CredentialInput, userId: string): Promise<Metadata> {
    const existing = await this.get(id, userId);
    if (!existing) {
      throw new Error("Credential not found");
    }

    const now = new Date().toISOString();
    const metadata: Metadata = { createdAt: existing.metadata.createdAt, updatedAt: now };
    const credential: Credential = { ...input, id, isDefault: existing.isDefault, metadata };

    const filePath = join(this.basePath, userId, `${id}.json`);
    await writeFile(filePath, JSON.stringify(credential, null, 2));

    return metadata;
  }

  async upsert(input: CredentialInput, userId: string): Promise<SaveResult> {
    // Find existing credential with same provider+label
    const existing = await this.findByProviderAndLabel(input.provider, input.label, userId);

    const now = new Date().toISOString();

    if (existing) {
      // Promote to default if no other credential for this provider is the default
      let isDefault = existing.isDefault;
      if (!isDefault) {
        const allForUser = await this.getAllForUser(userId);
        const hasDefault = allForUser.some(
          (c) => c.provider === input.provider && c.isDefault && c.id !== existing.id,
        );
        if (!hasDefault) {
          isDefault = true;
        }
      }
      const metadata: Metadata = { createdAt: existing.metadata.createdAt, updatedAt: now };
      const credential: Credential = { ...input, id: existing.id, isDefault, metadata };
      const filePath = join(this.basePath, userId, `${existing.id}.json`);
      await writeFile(filePath, JSON.stringify(credential, null, 2));
      return { id: existing.id, isDefault, metadata };
    }

    // Create new
    return this.save(input, userId);
  }

  private async getAllForUser(userId: string): Promise<Credential[]> {
    const userDir = join(this.basePath, userId);
    let files: string[];
    try {
      files = await readdir(userDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const credentials: Credential[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const content = await readFile(join(userDir, file), "utf-8");
      credentials.push(CredentialSchema.parse(JSON.parse(content)));
    }

    // Lazy migration: ensure each provider has a default (oldest-wins)
    const byProvider = new Map<string, Credential[]>();
    for (const cred of credentials) {
      const group = byProvider.get(cred.provider) ?? [];
      group.push(cred);
      byProvider.set(cred.provider, group);
    }
    for (const group of byProvider.values()) {
      if (group.some((c) => c.isDefault)) continue;
      const oldest = group.sort(
        (a, b) =>
          a.metadata.createdAt.localeCompare(b.metadata.createdAt) || a.id.localeCompare(b.id),
      )[0];
      if (oldest) {
        oldest.isDefault = true;
        await writeFile(join(userDir, `${oldest.id}.json`), JSON.stringify(oldest, null, 2));
      }
    }

    return credentials;
  }

  private async findByProviderAndLabel(
    provider: string,
    label: string,
    userId: string,
  ): Promise<Credential | null> {
    const credentials = await this.getAllForUser(userId);
    return credentials.find((c) => c.provider === provider && c.label === label) ?? null;
  }

  async list(type: string, userId: string): Promise<CredentialSummary[]> {
    const credentials = await this.getAllForUser(userId);
    const summaries: CredentialSummary[] = [];
    for (const cred of credentials) {
      if (cred.type === type) {
        const { secret: _, ...summary } = cred;
        summaries.push(summary);
      }
    }
    return summaries;
  }

  async delete(id: string, userId: string): Promise<void> {
    // Read the credential before deleting to check default status
    const credential = await this.get(id, userId);
    const filePath = join(this.basePath, userId, `${id}.json`);
    try {
      await unlink(filePath);
    } catch (error) {
      // Idempotent: silently succeed if file doesn't exist
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    // If deleted credential was the default, promote the oldest remaining
    if (credential?.isDefault) {
      const remaining = await this.getAllForUser(userId);
      const sameProvider = remaining.filter((c) => c.provider === credential.provider);
      const oldest = sameProvider.sort(
        (a, b) =>
          a.metadata.createdAt.localeCompare(b.metadata.createdAt) || a.id.localeCompare(b.id),
      )[0];
      if (oldest) {
        const now = new Date().toISOString();
        const promoted = {
          ...oldest,
          isDefault: true,
          metadata: { ...oldest.metadata, updatedAt: now },
        };
        await writeFile(
          join(this.basePath, userId, `${oldest.id}.json`),
          JSON.stringify(promoted, null, 2),
        );
      }
    }
  }

  async findByProviderAndExternalId(
    provider: string,
    externalId: string,
    userId: string,
  ): Promise<Credential | null> {
    const credentials = await this.getAllForUser(userId);
    for (const cred of credentials) {
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

  async updateMetadata(
    id: string,
    metadata: { displayName?: string },
    userId: string,
  ): Promise<Metadata> {
    const existing = await this.get(id, userId);
    if (!existing) {
      throw new Error("Credential not found");
    }

    const now = new Date().toISOString();
    const updatedMetadata: Metadata = { createdAt: existing.metadata.createdAt, updatedAt: now };
    const credential: Credential = {
      ...existing,
      displayName: metadata.displayName,
      metadata: updatedMetadata,
    };

    const filePath = join(this.basePath, userId, `${id}.json`);
    await writeFile(filePath, JSON.stringify(credential, null, 2));

    return updatedMetadata;
  }

  async setDefault(id: string, userId: string): Promise<void> {
    const credentials = await this.getAllForUser(userId);
    const target = credentials.find((c) => c.id === id);
    if (!target) {
      throw new Error("Credential not found");
    }
    if (target.isDefault) return;

    const now = new Date().toISOString();
    for (const cred of credentials) {
      if (cred.provider === target.provider && cred.isDefault) {
        const updated = {
          ...cred,
          isDefault: false,
          metadata: { ...cred.metadata, updatedAt: now },
        };
        await writeFile(
          join(this.basePath, userId, `${cred.id}.json`),
          JSON.stringify(updated, null, 2),
        );
      }
    }
    const updated = {
      ...target,
      isDefault: true,
      metadata: { ...target.metadata, updatedAt: now },
    };
    await writeFile(join(this.basePath, userId, `${id}.json`), JSON.stringify(updated, null, 2));
  }

  async getDefaultByProvider(provider: string, userId: string): Promise<Credential | null> {
    const credentials = await this.getAllForUser(userId);
    return credentials.find((c) => c.provider === provider && c.isDefault) ?? null;
  }
}

import { createHash } from "node:crypto";
import type { CorpusKind, KVCorpus } from "@atlas/agent-sdk";
import type { MountConsumer, MountSource } from "./types.ts";
import { MountConsumerSchema, MountSourceSchema } from "./types.ts";

export interface MountStorage extends KVCorpus {}

export function deriveSourceId(workspaceId: string, kind: CorpusKind, name: string): string {
  return createHash("sha256").update(`${workspaceId}:${kind}:${name}`).digest("hex");
}

const SOURCE_PREFIX = "mount:source:";
const CONSUMER_PREFIX = "mount:consumer:";
const IDX_CONSUMER_PREFIX = "mount:idx:consumer:";

export class MountRegistry {
  constructor(private readonly storage: MountStorage) {}

  async registerSource(workspaceId: string, kind: CorpusKind, name: string): Promise<MountSource> {
    const sourceId = deriveSourceId(workspaceId, kind, name);
    const existing = await this.storage.get<MountSource>(`${SOURCE_PREFIX}${sourceId}`);
    if (existing) return existing;
    const now = new Date().toISOString();
    const source: MountSource = MountSourceSchema.parse({
      sourceId,
      sourceWorkspaceId: workspaceId,
      corpusKind: kind,
      corpusName: name,
      createdAt: now,
      lastAccessedAt: now,
    });
    await this.storage.set(`${SOURCE_PREFIX}${sourceId}`, source);
    return source;
  }

  async addConsumer(sourceId: string, consumerWorkspaceId: string): Promise<void> {
    const key = `${CONSUMER_PREFIX}${sourceId}:${consumerWorkspaceId}`;
    const already = await this.storage.get(key);
    if (already) return;
    const entry: MountConsumer = MountConsumerSchema.parse({
      sourceId,
      consumerWorkspaceId,
      mountedAt: new Date().toISOString(),
    });
    await this.storage.set(key, entry);
    const idxKey = `${IDX_CONSUMER_PREFIX}${consumerWorkspaceId}`;
    const ids = (await this.storage.get<string[]>(idxKey)) ?? [];
    if (!ids.includes(sourceId)) {
      await this.storage.set(idxKey, [...ids, sourceId]);
    }
    await this._touchSource(sourceId);
  }

  async removeConsumer(sourceId: string, consumerWorkspaceId: string): Promise<void> {
    await this.storage.delete(`${CONSUMER_PREFIX}${sourceId}:${consumerWorkspaceId}`);
    const idxKey = `${IDX_CONSUMER_PREFIX}${consumerWorkspaceId}`;
    const ids = (await this.storage.get<string[]>(idxKey)) ?? [];
    await this.storage.set(
      idxKey,
      ids.filter((id) => id !== sourceId),
    );
  }

  async listConsumers(sourceId: string): Promise<MountConsumer[]> {
    const keys = await this.storage.list(`${CONSUMER_PREFIX}${sourceId}:`);
    const results = await Promise.all(
      keys.map((k) => this.storage.get<MountConsumer>(k) as Promise<MountConsumer>),
    );
    return results;
  }

  async listMountsForConsumer(consumerWorkspaceId: string): Promise<MountSource[]> {
    const idxKey = `${IDX_CONSUMER_PREFIX}${consumerWorkspaceId}`;
    const sourceIds = (await this.storage.get<string[]>(idxKey)) ?? [];
    const results = await Promise.all(sourceIds.map((id) => this.getSource(id)));
    return results.filter((s): s is MountSource => s !== undefined);
  }

  async getSource(sourceId: string): Promise<MountSource | undefined> {
    return await this.storage.get<MountSource>(`${SOURCE_PREFIX}${sourceId}`);
  }

  private async _touchSource(sourceId: string): Promise<void> {
    const src = await this.storage.get<MountSource>(`${SOURCE_PREFIX}${sourceId}`);
    if (!src) return;
    await this.storage.set(`${SOURCE_PREFIX}${sourceId}`, {
      ...src,
      lastAccessedAt: new Date().toISOString(),
    });
  }
}

import type { KVStore, StoreKind } from "@atlas/agent-sdk";
import {
  buildSourceId,
  type MountConsumer,
  MountConsumerSchema,
  type MountSource,
  MountSourceSchema,
} from "./types.ts";

const SRC = "mount:src:";
const CONS = "mount:cons:";
const IDX = "mount:idx:";

export class MountRegistry {
  constructor(private readonly kv: KVStore) {}

  async registerSource(workspaceId: string, kind: StoreKind, name: string): Promise<MountSource> {
    const id = buildSourceId(workspaceId, kind, name);
    const now = new Date().toISOString();

    const existing = await this.kv.get<MountSource>(`${SRC}${id}`);
    if (existing) {
      const updated: MountSource = { ...existing, lastAccessedAt: now };
      await this.kv.set(`${SRC}${id}`, updated);
      return MountSourceSchema.parse(updated);
    }

    const src: MountSource = { id, workspaceId, kind, name, createdAt: now, lastAccessedAt: now };
    await this.kv.set(`${SRC}${id}`, src);
    return MountSourceSchema.parse(src);
  }

  async getSource(sourceId: string): Promise<MountSource | undefined> {
    const raw = await this.kv.get<MountSource>(`${SRC}${sourceId}`);
    return raw ? MountSourceSchema.parse(raw) : undefined;
  }

  async addConsumer(sourceId: string, consumerId: string): Promise<void> {
    const key = `${CONS}${sourceId}:${consumerId}`;
    const idxKey = `${IDX}${consumerId}:${sourceId}`;

    const entry: MountConsumer = { consumerId, sourceId, addedAt: new Date().toISOString() };
    await this.kv.set(key, MountConsumerSchema.parse(entry));
    await this.kv.set(idxKey, sourceId);
  }

  async removeConsumer(sourceId: string, consumerId: string): Promise<void> {
    await this.kv.delete(`${CONS}${sourceId}:${consumerId}`);
    await this.kv.delete(`${IDX}${consumerId}:${sourceId}`);
  }

  async listConsumers(sourceId: string): Promise<MountConsumer[]> {
    const prefix = `${CONS}${sourceId}:`;
    const keys = await this.kv.list(prefix);
    const results: MountConsumer[] = [];
    for (const k of keys) {
      const v = await this.kv.get<MountConsumer>(k);
      if (v) results.push(MountConsumerSchema.parse(v));
    }
    return results;
  }

  async listMountsForConsumer(consumerId: string): Promise<MountSource[]> {
    const prefix = `${IDX}${consumerId}:`;
    const idxKeys = await this.kv.list(prefix);
    const sources: MountSource[] = [];
    for (const k of idxKeys) {
      const sourceId = await this.kv.get<string>(k);
      if (!sourceId) continue;
      const src = await this.getSource(sourceId);
      if (src) sources.push(src);
    }
    return sources;
  }
}

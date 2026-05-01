import type { KVStore } from "@atlas/agent-sdk";
import { describe, expect, it } from "vitest";
import { MountRegistry } from "./registry.ts";

function createPersistentKV(): KVStore {
  const store = new Map<string, string>();
  return {
    get<T = unknown>(key: string): Promise<T | undefined> {
      const raw = store.get(key);
      if (raw === undefined) return Promise.resolve(undefined);
      return Promise.resolve(JSON.parse(raw) as T);
    },
    set(key: string, value: unknown): Promise<void> {
      store.set(key, JSON.stringify(value));
      return Promise.resolve();
    },
    delete(key: string): Promise<void> {
      store.delete(key);
      return Promise.resolve();
    },
    list(prefix?: string): Promise<string[]> {
      const keys: string[] = [];
      for (const key of store.keys()) {
        if (!prefix || key.startsWith(prefix)) {
          keys.push(key);
        }
      }
      return Promise.resolve(keys);
    },
  };
}

describe("MountRegistry integration (serialized KV round-trip)", () => {
  it("round-trip: register → addConsumer → listConsumers returns persisted data", async () => {
    const kv = createPersistentKV();
    const registry = new MountRegistry(kv);

    const source = await registry.registerSource("ws-origin", "kv", "config");
    expect(source.id).toBe("ws-origin/kv/config");

    await registry.addConsumer(source.id, "ws-a");
    await registry.addConsumer(source.id, "ws-b");

    const consumers = await registry.listConsumers(source.id);
    expect(consumers).toHaveLength(2);
    const ids = consumers.map((c) => c.consumerId).sort();
    expect(ids).toEqual(["ws-a", "ws-b"]);
  });

  it("cross-consumer index consistency after add and remove", async () => {
    const kv = createPersistentKV();
    const registry = new MountRegistry(kv);

    const s1 = await registry.registerSource("ws-1", "narrative", "logs");
    const s2 = await registry.registerSource("ws-2", "retrieval", "docs");

    await registry.addConsumer(s1.id, "consumer-x");
    await registry.addConsumer(s2.id, "consumer-x");
    await registry.addConsumer(s1.id, "consumer-y");

    let mountsX = await registry.listMountsForConsumer("consumer-x");
    expect(mountsX).toHaveLength(2);

    const mountsY = await registry.listMountsForConsumer("consumer-y");
    expect(mountsY).toHaveLength(1);
    expect(mountsY[0]?.id).toBe(s1.id);

    await registry.removeConsumer(s1.id, "consumer-x");

    mountsX = await registry.listMountsForConsumer("consumer-x");
    expect(mountsX).toHaveLength(1);
    expect(mountsX[0]?.id).toBe(s2.id);

    const s1Consumers = await registry.listConsumers(s1.id);
    expect(s1Consumers).toHaveLength(1);
    expect(s1Consumers[0]?.consumerId).toBe("consumer-y");
  });

  it("second MountRegistry instance against same KV sees prior data", async () => {
    const sharedKV = createPersistentKV();

    const reg1 = new MountRegistry(sharedKV);
    const source = await reg1.registerSource("ws-1", "dedup", "seen");
    await reg1.addConsumer(source.id, "ws-2");

    const reg2 = new MountRegistry(sharedKV);
    const fetched = await reg2.getSource(source.id);
    expect(fetched).toBeDefined();
    expect(fetched?.workspaceId).toBe("ws-1");

    const consumers = await reg2.listConsumers(source.id);
    expect(consumers).toHaveLength(1);
    expect(consumers[0]?.consumerId).toBe("ws-2");

    const mounts = await reg2.listMountsForConsumer("ws-2");
    expect(mounts).toHaveLength(1);
  });
});

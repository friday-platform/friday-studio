import { beforeEach, describe, expect, it } from "vitest";
import type { MountStorage } from "./registry.ts";
import { deriveSourceId, MountRegistry } from "./registry.ts";
import { MountConsumerSchema, MountSourceSchema } from "./types.ts";

function createInMemoryKV(): MountStorage {
  const store = new Map<string, unknown>();
  return {
    get<T = unknown>(key: string): Promise<T | undefined> {
      return Promise.resolve(store.get(key) as T | undefined);
    },
    set(key: string, value: unknown): Promise<void> {
      store.set(key, structuredClone(value));
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

describe("MountRegistry", () => {
  let storage: MountStorage;
  let registry: MountRegistry;

  beforeEach(() => {
    storage = createInMemoryKV();
    registry = new MountRegistry(storage);
  });

  describe("registerSource", () => {
    it("creates a new MountSource with compound identity and returns it", async () => {
      const source = await registry.registerSource("ws-1", "narrative", "logs");
      const expectedId = deriveSourceId("ws-1", "narrative", "logs");
      expect(source.sourceId).toBe(expectedId);
      expect(source.sourceWorkspaceId).toBe("ws-1");
      expect(source.corpusKind).toBe("narrative");
      expect(source.corpusName).toBe("logs");
      expect(source.createdAt).toBeTruthy();
      expect(source.lastAccessedAt).toBeTruthy();
    });

    it("is idempotent — second call returns same source with preserved createdAt", async () => {
      const first = await registry.registerSource("ws-1", "narrative", "logs");
      const second = await registry.registerSource("ws-1", "narrative", "logs");
      expect(second.sourceId).toBe(first.sourceId);
      expect(second.createdAt).toBe(first.createdAt);
    });
  });

  describe("addConsumer", () => {
    it("writes a MountConsumer record and updates the reverse index", async () => {
      const source = await registry.registerSource("ws-1", "kv", "settings");
      await registry.addConsumer(source.sourceId, "ws-2");
      const consumers = await registry.listConsumers(source.sourceId);
      expect(consumers).toHaveLength(1);
      expect(consumers[0]?.consumerWorkspaceId).toBe("ws-2");
      expect(consumers[0]?.sourceId).toBe(source.sourceId);
    });

    it("is idempotent — calling twice does not duplicate the reverse index entry", async () => {
      const source = await registry.registerSource("ws-1", "kv", "settings");
      await registry.addConsumer(source.sourceId, "ws-2");
      await registry.addConsumer(source.sourceId, "ws-2");
      const consumers = await registry.listConsumers(source.sourceId);
      expect(consumers).toHaveLength(1);
    });

    it("updates lastAccessedAt on the source via _touchSource", async () => {
      const source = await registry.registerSource("ws-1", "narrative", "logs");
      const originalAccess = source.lastAccessedAt;

      await new Promise((resolve) => setTimeout(resolve, 5));

      await registry.addConsumer(source.sourceId, "ws-2");
      const updated = await registry.getSource(source.sourceId);
      expect(updated).toBeDefined();
      expect(updated?.lastAccessedAt).not.toBe(originalAccess);
    });
  });

  describe("removeConsumer", () => {
    it("deletes the consumer record and removes sourceId from reverse index", async () => {
      const source = await registry.registerSource("ws-1", "narrative", "logs");
      await registry.addConsumer(source.sourceId, "ws-2");
      await registry.addConsumer(source.sourceId, "ws-3");
      await registry.removeConsumer(source.sourceId, "ws-2");
      const consumers = await registry.listConsumers(source.sourceId);
      expect(consumers).toHaveLength(1);
      expect(consumers[0]?.consumerWorkspaceId).toBe("ws-3");
    });

    it("listConsumers returns empty after last consumer removed", async () => {
      const source = await registry.registerSource("ws-1", "dedup", "seen");
      await registry.addConsumer(source.sourceId, "ws-2");
      await registry.removeConsumer(source.sourceId, "ws-2");
      const consumers = await registry.listConsumers(source.sourceId);
      expect(consumers).toHaveLength(0);
    });

    it("is no-op for unknown sourceId", async () => {
      await expect(registry.removeConsumer("nonexistent-hash", "ws-2")).resolves.toBeUndefined();
    });
  });

  describe("listConsumers", () => {
    it("returns all MountConsumer entries for a given sourceId", async () => {
      const source = await registry.registerSource("ws-1", "retrieval", "docs");
      await registry.addConsumer(source.sourceId, "ws-A");
      await registry.addConsumer(source.sourceId, "ws-B");
      await registry.addConsumer(source.sourceId, "ws-C");
      const consumers = await registry.listConsumers(source.sourceId);
      expect(consumers).toHaveLength(3);
      const wsIds = consumers.map((c) => c.consumerWorkspaceId).sort();
      expect(wsIds).toEqual(["ws-A", "ws-B", "ws-C"]);
    });

    it("returns empty for unknown sourceId", async () => {
      const consumers = await registry.listConsumers("nonexistent-hash");
      expect(consumers).toEqual([]);
    });
  });

  describe("listMountsForConsumer", () => {
    it("returns all MountSource entries a consumer workspace has mounted", async () => {
      const s1 = await registry.registerSource("ws-1", "narrative", "logs");
      const s2 = await registry.registerSource("ws-2", "kv", "settings");
      await registry.addConsumer(s1.sourceId, "consumer-1");
      await registry.addConsumer(s2.sourceId, "consumer-1");
      const mounts = await registry.listMountsForConsumer("consumer-1");
      const ids = mounts.map((m) => m.sourceId).sort();
      expect(ids).toEqual([s1.sourceId, s2.sourceId].sort());
    });

    it("returns empty for consumer with no mounts", async () => {
      const mounts = await registry.listMountsForConsumer("nobody");
      expect(mounts).toEqual([]);
    });
  });

  describe("getSource", () => {
    it("returns undefined for unknown sourceId", async () => {
      const result = await registry.getSource("nonexistent-hash");
      expect(result).toBeUndefined();
    });

    it("returns the correct MountSource for a registered one", async () => {
      const source = await registry.registerSource("ws-1", "narrative", "logs");
      const fetched = await registry.getSource(source.sourceId);
      expect(fetched).toBeDefined();
      expect(fetched?.sourceWorkspaceId).toBe("ws-1");
      expect(fetched?.corpusKind).toBe("narrative");
    });
  });

  describe("Zod schema validation", () => {
    it("MountSourceSchema rejects entries with invalid corpusKind", () => {
      expect(() =>
        MountSourceSchema.parse({
          sourceId: "abc",
          sourceWorkspaceId: "ws-1",
          corpusKind: "invalid-kind",
          corpusName: "logs",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastAccessedAt: "2026-01-01T00:00:00.000Z",
        }),
      ).toThrow();
    });

    it("MountSourceSchema rejects entries missing required fields", () => {
      expect(() => MountSourceSchema.parse({})).toThrow();
      expect(() => MountSourceSchema.parse({ sourceId: "a", sourceWorkspaceId: "b" })).toThrow();
    });

    it("MountSourceSchema accepts valid records", () => {
      const result = MountSourceSchema.parse({
        sourceId: "abc123",
        sourceWorkspaceId: "ws-1",
        corpusKind: "narrative",
        corpusName: "logs",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastAccessedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(result.sourceId).toBe("abc123");
    });

    it("MountConsumerSchema rejects entries missing required fields", () => {
      expect(() => MountConsumerSchema.parse({})).toThrow();
      expect(() => MountConsumerSchema.parse({ sourceId: "a" })).toThrow();
    });

    it("MountConsumerSchema accepts valid records", () => {
      const result = MountConsumerSchema.parse({
        sourceId: "abc123",
        consumerWorkspaceId: "ws-2",
        mountedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(result.consumerWorkspaceId).toBe("ws-2");
    });
  });

  describe("integration: DenoKVCorpus satisfies MountStorage (in-memory stub)", () => {
    it("register → add consumers → list → get → remove → list empty", async () => {
      const source = await registry.registerSource("ws-origin", "kv", "config");

      await registry.addConsumer(source.sourceId, "ws-a");
      await registry.addConsumer(source.sourceId, "ws-b");

      const consumers = await registry.listConsumers(source.sourceId);
      expect(consumers).toHaveLength(2);
      const wsIds = consumers.map((c) => c.consumerWorkspaceId).sort();
      expect(wsIds).toEqual(["ws-a", "ws-b"]);

      const fetched = await registry.getSource(source.sourceId);
      expect(fetched).toBeDefined();
      expect(fetched?.sourceWorkspaceId).toBe("ws-origin");

      const mounts = await registry.listMountsForConsumer("ws-a");
      expect(mounts).toHaveLength(1);
      expect(mounts[0]?.sourceId).toBe(source.sourceId);

      await registry.removeConsumer(source.sourceId, "ws-a");
      await registry.removeConsumer(source.sourceId, "ws-b");

      const empty = await registry.listConsumers(source.sourceId);
      expect(empty).toEqual([]);
    });
  });

  describe("integration: CortexKVCorpus satisfies MountStorage (stub)", () => {
    it("full lifecycle against a stub implementing KVCorpus interface", async () => {
      const cortexStorage = createInMemoryKV();
      const cortexRegistry = new MountRegistry(cortexStorage);

      const source = await cortexRegistry.registerSource("ws-1", "retrieval", "docs");
      await cortexRegistry.addConsumer(source.sourceId, "ws-consumer");

      const consumers = await cortexRegistry.listConsumers(source.sourceId);
      expect(consumers).toHaveLength(1);
      expect(consumers[0]?.consumerWorkspaceId).toBe("ws-consumer");

      const fetched = await cortexRegistry.getSource(source.sourceId);
      expect(fetched).toBeDefined();

      const mounts = await cortexRegistry.listMountsForConsumer("ws-consumer");
      expect(mounts).toHaveLength(1);

      await cortexRegistry.removeConsumer(source.sourceId, "ws-consumer");
      const afterRemove = await cortexRegistry.listConsumers(source.sourceId);
      expect(afterRemove).toEqual([]);
    });
  });
});

import type { KVCorpus } from "@atlas/agent-sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { MountRegistry } from "./registry.ts";

function createInMemoryKV(): KVCorpus {
  const store = new Map<string, unknown>();
  return {
    get<T = unknown>(key: string): Promise<T | undefined> {
      const val = store.get(key);
      if (val === undefined) return Promise.resolve(undefined);
      return Promise.resolve(structuredClone(val) as T);
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
  let registry: MountRegistry;

  beforeEach(() => {
    registry = new MountRegistry(createInMemoryKV());
  });

  describe("registerSource", () => {
    it("creates a MountSource with correct fields", async () => {
      const source = await registry.registerSource("ws-1", "narrative", "logs");
      expect(source.id).toBe("ws-1/narrative/logs");
      expect(source.workspaceId).toBe("ws-1");
      expect(source.kind).toBe("narrative");
      expect(source.name).toBe("logs");
      expect(source.createdAt).toBeTruthy();
      expect(source.lastAccessedAt).toBe(source.createdAt);
    });

    it("is idempotent — returns same source with preserved createdAt and updated lastAccessedAt", async () => {
      const first = await registry.registerSource("ws-1", "narrative", "logs");
      await new Promise((resolve) => setTimeout(resolve, 5));
      const second = await registry.registerSource("ws-1", "narrative", "logs");
      expect(second.id).toBe(first.id);
      expect(second.createdAt).toBe(first.createdAt);
      expect(second.lastAccessedAt).not.toBe(first.lastAccessedAt);
    });
  });

  describe("getSource", () => {
    it("returns undefined for unknown sourceId", async () => {
      const result = await registry.getSource("nonexistent/kv/x");
      expect(result).toBeUndefined();
    });

    it("returns the registered source", async () => {
      const source = await registry.registerSource("ws-1", "kv", "config");
      const fetched = await registry.getSource(source.id);
      expect(fetched).toBeDefined();
      expect(fetched?.id).toBe(source.id);
      expect(fetched?.workspaceId).toBe("ws-1");
    });
  });

  describe("addConsumer", () => {
    it("adds a consumer entry for a source", async () => {
      const source = await registry.registerSource("ws-1", "kv", "settings");
      await registry.addConsumer(source.id, "ws-2");
      const consumers = await registry.listConsumers(source.id);
      expect(consumers).toHaveLength(1);
      expect(consumers[0]?.consumerId).toBe("ws-2");
      expect(consumers[0]?.sourceId).toBe(source.id);
      expect(consumers[0]?.addedAt).toBeTruthy();
    });

    it("allows multiple consumers for the same source", async () => {
      const source = await registry.registerSource("ws-1", "kv", "settings");
      await registry.addConsumer(source.id, "ws-2");
      await registry.addConsumer(source.id, "ws-3");
      const consumers = await registry.listConsumers(source.id);
      expect(consumers).toHaveLength(2);
      const ids = consumers.map((c) => c.consumerId).sort();
      expect(ids).toEqual(["ws-2", "ws-3"]);
    });

    it("overwrites on duplicate add", async () => {
      const source = await registry.registerSource("ws-1", "kv", "settings");
      await registry.addConsumer(source.id, "ws-2");
      await registry.addConsumer(source.id, "ws-2");
      const consumers = await registry.listConsumers(source.id);
      expect(consumers).toHaveLength(1);
    });
  });

  describe("removeConsumer", () => {
    it("removes from both forward and reverse index", async () => {
      const source = await registry.registerSource("ws-1", "narrative", "logs");
      await registry.addConsumer(source.id, "ws-2");
      await registry.addConsumer(source.id, "ws-3");
      await registry.removeConsumer(source.id, "ws-2");

      const consumers = await registry.listConsumers(source.id);
      expect(consumers).toHaveLength(1);
      expect(consumers[0]?.consumerId).toBe("ws-3");

      const mounts = await registry.listMountsForConsumer("ws-2");
      expect(mounts).toEqual([]);
    });

    it("is safe for unknown sourceId", async () => {
      await expect(registry.removeConsumer("nonexistent/kv/x", "ws-2")).resolves.toBeUndefined();
    });
  });

  describe("listConsumers", () => {
    it("returns MountConsumer objects", async () => {
      const source = await registry.registerSource("ws-1", "retrieval", "docs");
      await registry.addConsumer(source.id, "ws-A");
      await registry.addConsumer(source.id, "ws-B");
      await registry.addConsumer(source.id, "ws-C");

      const consumers = await registry.listConsumers(source.id);
      expect(consumers).toHaveLength(3);
      const ids = consumers.map((c) => c.consumerId).sort();
      expect(ids).toEqual(["ws-A", "ws-B", "ws-C"]);
      for (const c of consumers) {
        expect(c.sourceId).toBe(source.id);
        expect(c.addedAt).toBeTruthy();
      }
    });

    it("returns empty for unknown sourceId", async () => {
      const consumers = await registry.listConsumers("nonexistent/kv/x");
      expect(consumers).toEqual([]);
    });
  });

  describe("listMountsForConsumer", () => {
    it("returns full MountSource objects for all mounted sources", async () => {
      const s1 = await registry.registerSource("ws-1", "narrative", "logs");
      const s2 = await registry.registerSource("ws-2", "kv", "settings");
      await registry.addConsumer(s1.id, "consumer-1");
      await registry.addConsumer(s2.id, "consumer-1");
      const mounts = await registry.listMountsForConsumer("consumer-1");
      const ids = mounts.map((m) => m.id).sort();
      expect(ids).toEqual([s1.id, s2.id].sort());
    });

    it("returns empty for consumer with no mounts", async () => {
      const mounts = await registry.listMountsForConsumer("nobody");
      expect(mounts).toEqual([]);
    });
  });
});

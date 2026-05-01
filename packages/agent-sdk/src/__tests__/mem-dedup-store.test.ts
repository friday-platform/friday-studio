import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryMemoryAdapter, MemDedupStore } from "../mem-dedup-store.ts";
import type { DedupStore } from "../memory-adapter.ts";

describe("MemDedupStore", () => {
  let store: MemDedupStore;

  beforeEach(() => {
    store = new MemDedupStore("ws-test", "processed-tickets");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("filter returns only values not previously appended", () => {
    it("returns all values when nothing is stored", async () => {
      const result = await store.filter("tickets", "id", ["t-1", "t-2", "t-3"]);
      expect(result).toEqual(["t-1", "t-2", "t-3"]);
    });

    it("excludes previously appended values", async () => {
      await store.append("tickets", { id: "t-1" });
      await store.append("tickets", { id: "t-2" });

      const result = await store.filter("tickets", "id", ["t-1", "t-2", "t-3"]);
      expect(result).toEqual(["t-3"]);
    });

    it("excludes all values when entire batch was already processed", async () => {
      await store.append("tickets", { id: "t-1" });
      await store.append("tickets", { id: "t-2" });

      const result = await store.filter("tickets", "id", ["t-1", "t-2"]);
      expect(result).toEqual([]);
    });
  });

  describe("append with ttlHours — expired entries excluded from filter", () => {
    it("entries within TTL are excluded from filter results", async () => {
      const now = 1_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now);

      await store.append("tickets", { id: "t-1" }, 72);

      vi.spyOn(Date, "now").mockReturnValue(now + 71 * 3_600_000);
      const result = await store.filter("tickets", "id", ["t-1"]);
      expect(result).toEqual([]);
    });

    it("entries past TTL reappear as novel in filter results", async () => {
      const now = 1_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now);

      await store.append("tickets", { id: "t-1" }, 72);

      vi.spyOn(Date, "now").mockReturnValue(now + 73 * 3_600_000);
      const result = await store.filter("tickets", "id", ["t-1"]);
      expect(result).toEqual(["t-1"]);
    });

    it("entries without TTL never expire", async () => {
      const now = 1_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now);

      await store.append("tickets", { id: "t-1" });

      vi.spyOn(Date, "now").mockReturnValue(now + 100_000 * 3_600_000);
      const result = await store.filter("tickets", "id", ["t-1"]);
      expect(result).toEqual([]);
    });
  });

  describe("clear wipes namespace without affecting other namespaces", () => {
    it("removes all entries from the cleared namespace", async () => {
      await store.append("tickets", { id: "t-1" });
      await store.append("tickets", { id: "t-2" });

      await store.clear("tickets");

      const result = await store.filter("tickets", "id", ["t-1", "t-2"]);
      expect(result).toEqual(["t-1", "t-2"]);
    });

    it("preserves entries in other namespaces", async () => {
      await store.append("tickets", { id: "t-1" });
      await store.append("emails", { id: "e-1" });

      await store.clear("tickets");

      const ticketResult = await store.filter("tickets", "id", ["t-1"]);
      expect(ticketResult).toEqual(["t-1"]);

      const emailResult = await store.filter("emails", "id", ["e-1"]);
      expect(emailResult).toEqual([]);
    });
  });
});

describe("InMemoryMemoryAdapter", () => {
  let adapter: InMemoryMemoryAdapter;
  const workspaceId = "ws-cs-knowledge";

  beforeEach(() => {
    adapter = new InMemoryMemoryAdapter();
  });

  describe("cs-knowledge batch dedup integration", () => {
    it("processes a batch of tickets, replays same batch, no duplicates", async () => {
      const dedup: DedupStore = await adapter.store(workspaceId, "processed-tickets", "dedup");
      const incomingIds = ["t-100", "t-101", "t-102"];

      const unseen = await dedup.filter("tickets", "id", incomingIds);
      expect(unseen).toEqual(["t-100", "t-101", "t-102"]);

      await Promise.all(unseen.map((id) => dedup.append("tickets", { id }, 72)));

      const replay = await dedup.filter("tickets", "id", incomingIds);
      expect(replay).toEqual([]);
    });

    it("partial overlap returns only novel ticket IDs", async () => {
      const dedup: DedupStore = await adapter.store(workspaceId, "processed-tickets", "dedup");

      await dedup.append("tickets", { id: "t-200" }, 72);
      await dedup.append("tickets", { id: "t-201" }, 72);

      const mixed = await dedup.filter("tickets", "id", ["t-200", "t-201", "t-202", "t-203"]);
      expect(mixed).toEqual(["t-202", "t-203"]);
    });
  });

  describe("list returns StoreMetadata after store() call", () => {
    it("returns empty array before any store is created", async () => {
      const result = await adapter.list(workspaceId);
      expect(result).toEqual([]);
    });

    it("returns StoreMetadata for processed-tickets after first store() call", async () => {
      await adapter.store(workspaceId, "processed-tickets", "dedup");

      const result = await adapter.list(workspaceId);
      expect(result).toEqual([{ name: "processed-tickets", kind: "dedup", workspaceId }]);
    });

    it("does not duplicate metadata on repeated store() calls", async () => {
      await adapter.store(workspaceId, "processed-tickets", "dedup");
      await adapter.store(workspaceId, "processed-tickets", "dedup");

      const result = await adapter.list(workspaceId);
      expect(result).toHaveLength(1);
    });

    it("returns metadata only for the requested workspaceId", async () => {
      await adapter.store(workspaceId, "processed-tickets", "dedup");
      await adapter.store("ws-other", "other-dedup", "dedup");

      const result = await adapter.list(workspaceId);
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("processed-tickets");
    });
  });
});

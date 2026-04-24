import type { DedupEntry, DedupStore, MemoryAdapter } from "@atlas/agent-sdk";
import { describe, expect, it } from "vitest";

class InMemoryDedupStore implements DedupStore {
  private store = new Map<string, Map<string, DedupEntry>>();

  append(namespace: string, entry: DedupEntry, _ttlHours?: number): Promise<void> {
    if (!this.store.has(namespace)) {
      this.store.set(namespace, new Map());
    }
    const ns = this.store.get(namespace);
    const key = JSON.stringify(entry);
    ns?.set(key, entry);
    return Promise.resolve();
  }

  filter(namespace: string, field: string, values: unknown[]): Promise<unknown[]> {
    const ns = this.store.get(namespace);
    if (!ns) return Promise.resolve(values);

    const seen = new Set<unknown>();
    for (const [, entry] of ns) {
      if (field in entry) {
        seen.add(entry[field]);
      }
    }

    return Promise.resolve(values.filter((v) => !seen.has(v)));
  }

  clear(namespace: string): Promise<void> {
    this.store.delete(namespace);
    return Promise.resolve();
  }
}

function makeAdapter(): { adapter: MemoryAdapter; store: InMemoryDedupStore } {
  const store = new InMemoryDedupStore();
  const adapter: MemoryAdapter = {
    store: () => Promise.resolve(store as never),
    list: () => Promise.resolve([]),
    bootstrap: () => Promise.resolve(""),
    history: () => Promise.resolve([]),
    rollback: () => Promise.resolve(),
  };
  return { adapter, store };
}

describe("DedupStore hot-path: filter replaces Set<string>", () => {
  it("new ticket IDs pass through filter unchanged", async () => {
    const { adapter } = makeAdapter();
    const store = await adapter.store("ws-test", "processed-tickets", "dedup");

    const candidates = ["t-new-1", "t-new-2", "t-new-3"];
    const unseen = await store.filter("tickets", "ticketId", candidates);

    expect(unseen).toEqual(["t-new-1", "t-new-2", "t-new-3"]);
  });

  it("processed ticket IDs are filtered out", async () => {
    const { adapter } = makeAdapter();
    const store = await adapter.store("ws-test", "processed-tickets", "dedup");

    await store.append("tickets", { ticketId: "t-1" });
    await store.append("tickets", { ticketId: "t-2" });

    const unseen = await store.filter("tickets", "ticketId", ["t-1", "t-2", "t-3"]);

    expect(unseen).toEqual(["t-3"]);
  });

  it("mixed batch returns only unseen IDs", async () => {
    const { adapter } = makeAdapter();
    const store = await adapter.store("ws-test", "processed-tickets", "dedup");

    await store.append("tickets", { ticketId: "t-1" });
    await store.append("tickets", { ticketId: "t-3" });
    await store.append("tickets", { ticketId: "t-5" });

    const candidates = ["t-1", "t-2", "t-3", "t-4", "t-5"];
    const unseen = await store.filter("tickets", "ticketId", candidates);

    expect(unseen).toEqual(["t-2", "t-4"]);
  });

  it("empty candidate list returns empty", async () => {
    const { adapter } = makeAdapter();
    const store = await adapter.store("ws-test", "processed-tickets", "dedup");

    await store.append("tickets", { ticketId: "t-1" });

    const unseen = await store.filter("tickets", "ticketId", []);

    expect(unseen).toEqual([]);
  });

  it("append then filter round-trip is consistent", async () => {
    const { adapter } = makeAdapter();
    const store = await adapter.store("ws-test", "processed-tickets", "dedup");

    const batch = ["t-a", "t-b", "t-c"];
    for (const id of batch) {
      await store.append("tickets", { ticketId: id }, 168);
    }

    const unseen = await store.filter("tickets", "ticketId", batch);
    expect(unseen).toEqual([]);

    const mixed = await store.filter("tickets", "ticketId", [...batch, "t-d"]);
    expect(mixed).toEqual(["t-d"]);
  });
});

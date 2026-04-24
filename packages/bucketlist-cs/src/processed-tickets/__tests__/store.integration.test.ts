import type { DedupEntry, DedupStore, MemoryAdapter } from "@atlas/agent-sdk";
import { describe, expect, it } from "vitest";
import { createProcessedTicketStore } from "../store.ts";

class InMemoryDedupStore implements DedupStore {
  private store = new Map<string, Map<string, { entry: DedupEntry; expiresAt: number | null }>>();

  append(namespace: string, entry: DedupEntry, ttlHours?: number): Promise<void> {
    if (!this.store.has(namespace)) {
      this.store.set(namespace, new Map());
    }
    const ns = this.store.get(namespace);
    const key = JSON.stringify(entry);
    const expiresAt = ttlHours ? Date.now() + ttlHours * 3600_000 : null;
    ns?.set(key, { entry, expiresAt });
    return Promise.resolve();
  }

  filter(namespace: string, field: string, values: unknown[]): Promise<unknown[]> {
    const ns = this.store.get(namespace);
    if (!ns) return Promise.resolve(values);

    const now = Date.now();
    const seen = new Set<unknown>();
    for (const [, { entry, expiresAt }] of ns) {
      if (expiresAt !== null && expiresAt < now) continue;
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

function makeInMemoryAdapter(): MemoryAdapter {
  const stores = new Map<string, DedupStore>();
  return {
    store(_workspaceId, name, _kind) {
      if (!stores.has(name)) {
        stores.set(name, new InMemoryDedupStore());
      }
      return Promise.resolve(stores.get(name) as never);
    },
    list: () => Promise.resolve([]),
    bootstrap: () => Promise.resolve(""),
    history: () => Promise.resolve([]),
    rollback: () => Promise.resolve(),
  };
}

describe("ProcessedTicketStore integration (in-memory DedupStore)", () => {
  it("filters out known IDs after recording them", async () => {
    const adapter = makeInMemoryAdapter();
    const store = await createProcessedTicketStore(adapter, "ws-test");

    await store.recordProcessed(["t-1", "t-2", "t-3"]);
    const unseen = await store.filterNew(["t-1", "t-2", "t-3"]);

    expect(unseen).toEqual([]);
  });

  it("returns all IDs when none have been recorded", async () => {
    const adapter = makeInMemoryAdapter();
    const store = await createProcessedTicketStore(adapter, "ws-test");

    const unseen = await store.filterNew(["t-a", "t-b", "t-c"]);

    expect(unseen).toEqual(["t-a", "t-b", "t-c"]);
  });

  it("returns only unknown IDs from a mixed batch", async () => {
    const adapter = makeInMemoryAdapter();
    const store = await createProcessedTicketStore(adapter, "ws-test");

    await store.recordProcessed(["t-1", "t-3"]);
    const unseen = await store.filterNew(["t-1", "t-2", "t-3", "t-4"]);

    expect(unseen).toEqual(["t-2", "t-4"]);
  });

  it("clear resets all recorded IDs", async () => {
    const adapter = makeInMemoryAdapter();
    const store = await createProcessedTicketStore(adapter, "ws-test");

    await store.recordProcessed(["t-1", "t-2"]);
    await store.clear();
    const unseen = await store.filterNew(["t-1", "t-2"]);

    expect(unseen).toEqual(["t-1", "t-2"]);
  });

  it("handles empty candidate list", async () => {
    const adapter = makeInMemoryAdapter();
    const store = await createProcessedTicketStore(adapter, "ws-test");

    const unseen = await store.filterNew([]);

    expect(unseen).toEqual([]);
  });
});

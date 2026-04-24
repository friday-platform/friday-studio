import type { DedupEntry, DedupStore, MemoryAdapter } from "@atlas/agent-sdk";
import { describe, expect, it } from "vitest";
import { runMigration } from "../dedup-migration.ts";

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

  entryCount(namespace: string): number {
    return this.store.get(namespace)?.size ?? 0;
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

describe("runMigration", () => {
  it("migrates all legacy IDs into the dedup store", async () => {
    const { adapter, store } = makeAdapter();
    const ids = ["t-1", "t-2", "t-3"];

    const result = await runMigration(adapter, "ws-test", ids);

    expect(result).toEqual({ migrated: 3, skipped: 0 });
    expect(store.entryCount("tickets")).toBe(3);
  });

  it("is idempotent — second run produces migrated=0", async () => {
    const { adapter } = makeAdapter();
    const ids = ["t-1", "t-2", "t-3"];

    await runMigration(adapter, "ws-test", ids);
    const second = await runMigration(adapter, "ws-test", ids);

    expect(second).toEqual({ migrated: 0, skipped: 3 });
  });

  it("skips pre-existing entries and migrates only new ones", async () => {
    const { adapter, store } = makeAdapter();

    await store.append("tickets", { ticketId: "t-1" });
    await store.append("tickets", { ticketId: "t-3" });

    const result = await runMigration(adapter, "ws-test", ["t-1", "t-2", "t-3", "t-4"]);

    expect(result).toEqual({ migrated: 2, skipped: 2 });
    expect(store.entryCount("tickets")).toBe(4);
  });

  it("handles empty legacy ID list", async () => {
    const { adapter } = makeAdapter();

    const result = await runMigration(adapter, "ws-test", []);

    expect(result).toEqual({ migrated: 0, skipped: 0 });
  });
});

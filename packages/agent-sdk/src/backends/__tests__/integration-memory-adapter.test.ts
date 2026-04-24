import { Database } from "@db/sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { DedupStore, KVStore } from "../../memory-adapter.ts";
import { SqliteDedupStore } from "../sqlite-dedup-store.ts";
import { SqliteKVStore } from "../sqlite-kv-store.ts";

describe("Integration: MemoryAdapter.store() factory pattern", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("kind='dedup'", () => {
    test("creates a working DedupStore via the factory", async () => {
      const store: DedupStore = SqliteDedupStore.create(db, "ws1", "dedup-test");

      await store.append("ns", { url: "https://example.com" });
      const novel = await store.filter("ns", "url", ["https://example.com", "https://new.com"]);
      expect(novel).toEqual(["https://new.com"]);
    });

    test("clear removes all entries", async () => {
      const store: DedupStore = SqliteDedupStore.create(db, "ws1", "dedup-test");

      await store.append("ns", { a: "1", b: "2" });
      await store.clear("ns");
      const novel = await store.filter("ns", "a", ["1"]);
      expect(novel).toEqual(["1"]);
    });
  });

  describe("kind='kv'", () => {
    test("creates a working KVStore via the factory", async () => {
      const kv: KVStore = SqliteKVStore.create(db, "ws1", "kv-test");

      await kv.set("greeting", "hello");
      const result = await kv.get("greeting");
      expect(result).toBe("hello");
    });

    test("list returns keys matching prefix", async () => {
      const kv: KVStore = SqliteKVStore.create(db, "ws1", "kv-test");

      await kv.set("cfg:a", 1);
      await kv.set("cfg:b", 2);
      await kv.set("data:x", 3);

      const cfgKeys = await kv.list("cfg:");
      expect(cfgKeys.sort()).toEqual(["cfg:a", "cfg:b"]);
    });

    test("delete removes a key", async () => {
      const kv: KVStore = SqliteKVStore.create(db, "ws1", "kv-test");

      await kv.set("key", "value");
      await kv.delete("key");
      expect(await kv.get("key")).toBeUndefined();
    });
  });

  describe("isolation between stores on the same database", () => {
    test("dedup and kv do not interfere with each other", async () => {
      const dedup: DedupStore = SqliteDedupStore.create(db, "ws1", "dedup");
      const kv: KVStore = SqliteKVStore.create(db, "ws1", "kv");

      await dedup.append("ns", { key: "val" });
      await kv.set("key", "kv-val");

      const dedupResult = await dedup.filter("ns", "key", ["val"]);
      expect(dedupResult).toEqual([]);

      const kvResult = await kv.get("key");
      expect(kvResult).toBe("kv-val");
    });
  });
});

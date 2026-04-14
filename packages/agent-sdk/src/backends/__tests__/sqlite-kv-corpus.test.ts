import { Database } from "@db/sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SqliteKVCorpus } from "../sqlite-kv-corpus.ts";

describe("SqliteKVCorpus", () => {
  let db: Database;
  let kv: SqliteKVCorpus;

  beforeEach(() => {
    db = new Database(":memory:");
    kv = SqliteKVCorpus.create(db, "ws-test", "kv-test");
  });

  afterEach(() => {
    db.close();
  });

  describe("get/set", () => {
    test("returns undefined for missing key", async () => {
      const result = await kv.get("missing");
      expect(result).toBeUndefined();
    });

    test("stores and retrieves a string value", async () => {
      await kv.set("key1", "hello");
      const result = await kv.get("key1");
      expect(result).toBe("hello");
    });

    test("stores and retrieves a number value", async () => {
      await kv.set("count", 42);
      const result = await kv.get("count");
      expect(result).toBe(42);
    });

    test("stores and retrieves a complex object", async () => {
      const obj = { nested: { arr: [1, 2, 3], flag: true }, name: "test" };
      await kv.set("obj", obj);
      const result = await kv.get("obj");
      expect(result).toEqual(obj);
    });

    test("stores and retrieves null value", async () => {
      await kv.set("nullable", null);
      const result = await kv.get("nullable");
      expect(result).toBeNull();
    });

    test("overwrites existing key", async () => {
      await kv.set("key1", "first");
      await kv.set("key1", "second");
      const result = await kv.get("key1");
      expect(result).toBe("second");
    });
  });

  describe("delete", () => {
    test("removes an existing key", async () => {
      await kv.set("key1", "val");
      await kv.delete("key1");
      const result = await kv.get("key1");
      expect(result).toBeUndefined();
    });

    test("is a no-op for missing key", async () => {
      await kv.delete("nonexistent");
    });
  });

  describe("list", () => {
    test("returns all keys when no prefix given", async () => {
      await kv.set("a", 1);
      await kv.set("b", 2);
      await kv.set("c", 3);

      const keys = await kv.list();
      expect(keys.sort()).toEqual(["a", "b", "c"]);
    });

    test("filters by prefix", async () => {
      await kv.set("user:1", "alice");
      await kv.set("user:2", "bob");
      await kv.set("config:theme", "dark");

      const userKeys = await kv.list("user:");
      expect(userKeys.sort()).toEqual(["user:1", "user:2"]);

      const configKeys = await kv.list("config:");
      expect(configKeys).toEqual(["config:theme"]);
    });

    test("returns empty array when no keys match prefix", async () => {
      await kv.set("a", 1);
      const result = await kv.list("z:");
      expect(result).toEqual([]);
    });

    test("excludes expired keys from listing", async () => {
      const pastTime = 1_000_000;
      vi.spyOn(Date, "now").mockReturnValue(pastTime);
      await kv.set("expired", "val", 1);
      await kv.set("fresh", "val");

      vi.spyOn(Date, "now").mockReturnValue(pastTime + 2_000);
      const keys = await kv.list();
      expect(keys).toEqual(["fresh"]);

      vi.restoreAllMocks();
    });
  });

  describe("TTL expiry", () => {
    test("get returns undefined for expired key and deletes it", async () => {
      const pastTime = 1_000_000;
      vi.spyOn(Date, "now").mockReturnValue(pastTime);
      await kv.set("key1", "val", 5);

      vi.spyOn(Date, "now").mockReturnValue(pastTime + 6_000);
      const result = await kv.get("key1");
      expect(result).toBeUndefined();

      const rows = db.prepare("SELECT * FROM kv_entries WHERE key = ?").all("key1") as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(0);

      vi.restoreAllMocks();
    });

    test("get returns value before TTL expires", async () => {
      const pastTime = 1_000_000;
      vi.spyOn(Date, "now").mockReturnValue(pastTime);
      await kv.set("key1", "val", 10);

      vi.spyOn(Date, "now").mockReturnValue(pastTime + 5_000);
      const result = await kv.get("key1");
      expect(result).toBe("val");

      vi.restoreAllMocks();
    });

    test("set without ttlSeconds stores with no expiry", async () => {
      await kv.set("key1", "val");

      const row = db.prepare("SELECT expires_at FROM kv_entries WHERE key = ?").get("key1") as {
        expires_at: number | null;
      };
      expect(row.expires_at).toBeNull();
    });
  });

  describe("JSON round-trip", () => {
    test("preserves arrays", async () => {
      await kv.set("arr", [1, "two", null, true]);
      expect(await kv.get("arr")).toEqual([1, "two", null, true]);
    });

    test("preserves deeply nested structures", async () => {
      const deep = { a: { b: { c: { d: [{ e: "f" }] } } } };
      await kv.set("deep", deep);
      expect(await kv.get("deep")).toEqual(deep);
    });

    test("preserves boolean values", async () => {
      await kv.set("t", true);
      await kv.set("f", false);
      expect(await kv.get("t")).toBe(true);
      expect(await kv.get("f")).toBe(false);
    });
  });
});

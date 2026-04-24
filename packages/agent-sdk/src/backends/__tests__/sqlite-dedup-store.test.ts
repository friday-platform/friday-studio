import { Database } from "@db/sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SqliteDedupStore } from "../sqlite-dedup-store.ts";

describe("SqliteDedupStore", () => {
  let db: Database;
  let store: SqliteDedupStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = SqliteDedupStore.create(db, "ws-test", "dedup-test");
  });

  afterEach(() => {
    db.close();
  });

  describe("append", () => {
    test("stores entry fields as individual rows", async () => {
      await store.append("ns1", { url: "https://a.com", title: "A" });

      const rows = db.prepare("SELECT * FROM dedup_entries").all() as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(2);
    });

    test("upserts on duplicate (namespace, field, value)", async () => {
      await store.append("ns1", { url: "https://a.com" });
      await store.append("ns1", { url: "https://a.com" });

      const rows = db.prepare("SELECT * FROM dedup_entries").all() as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(1);
    });

    test("sets expires_at when ttlHours is provided", async () => {
      const now = 1_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now);

      await store.append("ns1", { key: "val" }, 2);

      const row = db.prepare("SELECT expires_at FROM dedup_entries").get() as {
        expires_at: number;
      };
      expect(row.expires_at).toBe(now + 2 * 3_600_000);

      vi.restoreAllMocks();
    });

    test("leaves expires_at null when ttlHours is omitted", async () => {
      await store.append("ns1", { key: "val" });

      const row = db.prepare("SELECT expires_at FROM dedup_entries").get() as {
        expires_at: number | null;
      };
      expect(row.expires_at).toBeNull();
    });
  });

  describe("filter", () => {
    test("returns all values when nothing is stored", async () => {
      const result = await store.filter("ns1", "url", ["https://a.com", "https://b.com"]);
      expect(result).toEqual(["https://a.com", "https://b.com"]);
    });

    test("excludes values already in the store", async () => {
      await store.append("ns1", { url: "https://a.com" });

      const result = await store.filter("ns1", "url", ["https://a.com", "https://b.com"]);
      expect(result).toEqual(["https://b.com"]);
    });

    test("returns expired values as novel", async () => {
      const pastTime = 1_000_000;
      vi.spyOn(Date, "now").mockReturnValue(pastTime);
      await store.append("ns1", { url: "https://a.com" }, 1);

      vi.spyOn(Date, "now").mockReturnValue(pastTime + 2 * 3_600_000);
      const result = await store.filter("ns1", "url", ["https://a.com"]);
      expect(result).toEqual(["https://a.com"]);

      vi.restoreAllMocks();
    });

    test("handles complex values with JSON serialization", async () => {
      await store.append("ns1", { data: { nested: true } });

      const result = await store.filter("ns1", "data", [{ nested: true }, { nested: false }]);
      expect(result).toEqual([{ nested: false }]);
    });
  });

  describe("clear", () => {
    test("removes all entries for the given namespace", async () => {
      await store.append("ns1", { a: "1" });
      await store.append("ns2", { b: "2" });

      await store.clear("ns1");

      const rows = db.prepare("SELECT * FROM dedup_entries").all() as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(1);
    });
  });

  describe("multi-namespace isolation", () => {
    test("filter only checks within the specified namespace", async () => {
      await store.append("ns1", { url: "https://a.com" });
      await store.append("ns2", { url: "https://a.com" });

      const ns1Result = await store.filter("ns1", "url", ["https://a.com"]);
      expect(ns1Result).toEqual([]);

      await store.clear("ns1");

      const ns1After = await store.filter("ns1", "url", ["https://a.com"]);
      expect(ns1After).toEqual(["https://a.com"]);

      const ns2After = await store.filter("ns2", "url", ["https://a.com"]);
      expect(ns2After).toEqual([]);
    });
  });

  describe("TTL pruning", () => {
    test("prunes expired rows from all namespaces on append", async () => {
      const pastTime = 1_000_000;
      vi.spyOn(Date, "now").mockReturnValue(pastTime);
      await store.append("ns1", { old: "val" }, 1);

      vi.spyOn(Date, "now").mockReturnValue(pastTime + 2 * 3_600_000);
      await store.append("ns2", { fresh: "val" });

      const rows = db.prepare("SELECT * FROM dedup_entries").all() as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(1);

      vi.restoreAllMocks();
    });
  });
});

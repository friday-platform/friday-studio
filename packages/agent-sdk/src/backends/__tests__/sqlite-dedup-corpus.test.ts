import { Database } from "@db/sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SqliteDedupCorpus } from "../sqlite-dedup-corpus.ts";

describe("SqliteDedupCorpus", () => {
  let db: Database;
  let corpus: SqliteDedupCorpus;

  beforeEach(() => {
    db = new Database(":memory:");
    corpus = SqliteDedupCorpus.create(db, "ws-test", "dedup-test");
  });

  afterEach(() => {
    db.close();
  });

  describe("append", () => {
    test("stores entry fields as individual rows", async () => {
      await corpus.append("ns1", { url: "https://a.com", title: "A" });

      const rows = db.prepare("SELECT * FROM dedup_entries").all() as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(2);
    });

    test("upserts on duplicate (namespace, field, value)", async () => {
      await corpus.append("ns1", { url: "https://a.com" });
      await corpus.append("ns1", { url: "https://a.com" });

      const rows = db.prepare("SELECT * FROM dedup_entries").all() as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(1);
    });

    test("sets expires_at when ttlHours is provided", async () => {
      const now = 1_000_000;
      vi.spyOn(Date, "now").mockReturnValue(now);

      await corpus.append("ns1", { key: "val" }, 2);

      const row = db.prepare("SELECT expires_at FROM dedup_entries").get() as {
        expires_at: number;
      };
      expect(row.expires_at).toBe(now + 2 * 3_600_000);

      vi.restoreAllMocks();
    });

    test("leaves expires_at null when ttlHours is omitted", async () => {
      await corpus.append("ns1", { key: "val" });

      const row = db.prepare("SELECT expires_at FROM dedup_entries").get() as {
        expires_at: number | null;
      };
      expect(row.expires_at).toBeNull();
    });
  });

  describe("filter", () => {
    test("returns all values when nothing is stored", async () => {
      const result = await corpus.filter("ns1", "url", ["https://a.com", "https://b.com"]);
      expect(result).toEqual(["https://a.com", "https://b.com"]);
    });

    test("excludes values already in the corpus", async () => {
      await corpus.append("ns1", { url: "https://a.com" });

      const result = await corpus.filter("ns1", "url", ["https://a.com", "https://b.com"]);
      expect(result).toEqual(["https://b.com"]);
    });

    test("returns expired values as novel", async () => {
      const pastTime = 1_000_000;
      vi.spyOn(Date, "now").mockReturnValue(pastTime);
      await corpus.append("ns1", { url: "https://a.com" }, 1);

      vi.spyOn(Date, "now").mockReturnValue(pastTime + 2 * 3_600_000);
      const result = await corpus.filter("ns1", "url", ["https://a.com"]);
      expect(result).toEqual(["https://a.com"]);

      vi.restoreAllMocks();
    });

    test("handles complex values with JSON serialization", async () => {
      await corpus.append("ns1", { data: { nested: true } });

      const result = await corpus.filter("ns1", "data", [{ nested: true }, { nested: false }]);
      expect(result).toEqual([{ nested: false }]);
    });
  });

  describe("clear", () => {
    test("removes all entries for the given namespace", async () => {
      await corpus.append("ns1", { a: "1" });
      await corpus.append("ns2", { b: "2" });

      await corpus.clear("ns1");

      const rows = db.prepare("SELECT * FROM dedup_entries").all() as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(1);
    });
  });

  describe("multi-namespace isolation", () => {
    test("filter only checks within the specified namespace", async () => {
      await corpus.append("ns1", { url: "https://a.com" });
      await corpus.append("ns2", { url: "https://a.com" });

      const ns1Result = await corpus.filter("ns1", "url", ["https://a.com"]);
      expect(ns1Result).toEqual([]);

      await corpus.clear("ns1");

      const ns1After = await corpus.filter("ns1", "url", ["https://a.com"]);
      expect(ns1After).toEqual(["https://a.com"]);

      const ns2After = await corpus.filter("ns2", "url", ["https://a.com"]);
      expect(ns2After).toEqual([]);
    });
  });

  describe("TTL pruning", () => {
    test("prunes expired rows from all namespaces on append", async () => {
      const pastTime = 1_000_000;
      vi.spyOn(Date, "now").mockReturnValue(pastTime);
      await corpus.append("ns1", { old: "val" }, 1);

      vi.spyOn(Date, "now").mockReturnValue(pastTime + 2 * 3_600_000);
      await corpus.append("ns2", { fresh: "val" });

      const rows = db.prepare("SELECT * FROM dedup_entries").all() as Array<
        Record<string, unknown>
      >;
      expect(rows).toHaveLength(1);

      vi.restoreAllMocks();
    });
  });
});

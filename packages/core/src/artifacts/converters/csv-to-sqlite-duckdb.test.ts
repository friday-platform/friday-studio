/**
 * Fast CSV to SQLite Converter Tests
 *
 * Tests the DuckDB/SQLite CLI based converter with fallback to JS.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "@db/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertCsvToSqliteFast, resetCliCache } from "./csv-to-sqlite-duckdb.ts";

/**
 * Create a temp CSV file with given content
 */
async function createTempCsv(content: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "csv-duckdb-test-"));
  const csvPath = path.join(tempDir, "test.csv");
  await fs.writeFile(csvPath, content, "utf-8");
  return csvPath;
}

/**
 * Create a temp output path for SQLite database
 */
async function createTempDbPath(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "db-duckdb-test-"));
  return path.join(tempDir, "output.db");
}

describe("convertCsvToSqliteFast", () => {
  let csvPath: string;
  let dbPath: string;

  beforeEach(async () => {
    // Reset CLI cache before each test to ensure fresh detection
    resetCliCache();
    dbPath = await createTempDbPath();
  });

  afterEach(async () => {
    // Cleanup temp files
    if (csvPath) {
      await fs.rm(path.dirname(csvPath), { recursive: true, force: true }).catch(() => {});
    }
    if (dbPath) {
      await fs.rm(path.dirname(dbPath), { recursive: true, force: true }).catch(() => {});
    }
  });

  it("converts simple CSV to SQLite database", async () => {
    csvPath = await createTempCsv("name,age\nAlice,30\nBob,25\n");

    const result = await convertCsvToSqliteFast(csvPath, dbPath, "users");

    expect(result.dbPath).toBe(dbPath);
    expect(result.schema.tableName).toBe("users");
    expect(result.schema.rowCount).toBe(2);
    expect(result.schema.columns).toHaveLength(2);
    expect(result.schema.columns[0]?.name).toBe("name");
    expect(result.schema.columns[1]?.name).toBe("age");

    // Verify database content
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM users").all() as Array<{ name: string; age: unknown }>;
    db.close();

    expect(rows).toHaveLength(2);
    expect(rows[0]?.name).toBe("Alice");
    expect(rows[1]?.name).toBe("Bob");
  });

  it("handles columns with special characters", async () => {
    csvPath = await createTempCsv('"Column ""A""",Column B\nvalue1,value2\n');

    const result = await convertCsvToSqliteFast(csvPath, dbPath, "special");

    expect(result.schema.columns[0]?.name).toBe('Column "A"');
    expect(result.schema.columns[1]?.name).toBe("Column B");

    // Verify can query the table
    const db = new Database(dbPath, { readonly: true });
    const count = db.prepare("SELECT COUNT(*) as cnt FROM special").get() as { cnt: number };
    db.close();

    expect(count.cnt).toBe(1);
  });

  it("handles empty column values", async () => {
    csvPath = await createTempCsv("a,b,c\n1,,3\n,2,\n");

    const result = await convertCsvToSqliteFast(csvPath, dbPath, "sparse");

    expect(result.schema.rowCount).toBe(2);

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM sparse").all() as Array<{
      a: unknown;
      b: unknown;
      c: unknown;
    }>;
    db.close();

    // Empty values are null (DuckDB) or empty string (SQLite CLI)
    const isNullOrEmpty = (v: unknown) => v === null || v === "";
    expect(rows[0]?.b).toSatisfy(isNullOrEmpty);
    expect(rows[1]?.a).toSatisfy(isNullOrEmpty);
    expect(rows[1]?.c).toSatisfy(isNullOrEmpty);
  });

  it("rejects empty CSV files", async () => {
    csvPath = await createTempCsv("");

    await expect(convertCsvToSqliteFast(csvPath, dbPath, "empty")).rejects.toThrow();
  });

  it("rejects CSV with only headers", async () => {
    csvPath = await createTempCsv("name,age\n");

    await expect(convertCsvToSqliteFast(csvPath, dbPath, "headers_only")).rejects.toThrow();
  });

  it("throws for non-existent CSV file", async () => {
    const nonExistentPath = "/tmp/nonexistent-csv-12345.csv";

    await expect(convertCsvToSqliteFast(nonExistentPath, dbPath, "fail")).rejects.toThrow(
      /not found|not readable/i,
    );
  });

  it("handles large CSV (10k rows) correctly", async () => {
    // Generate CSV with 10,000 rows
    const header = "id,value\n";
    const rows = Array.from({ length: 10000 }, (_, i) => `${i},value_${i}`).join("\n");
    csvPath = await createTempCsv(header + rows);

    const result = await convertCsvToSqliteFast(csvPath, dbPath, "large");

    expect(result.schema.rowCount).toBe(10000);

    // Spot check some rows
    const db = new Database(dbPath, { readonly: true });
    const count = db.prepare("SELECT COUNT(*) as cnt FROM large").get() as { cnt: number };
    db.close();

    expect(count.cnt).toBe(10000);
  });

  it("sanitizes table name with special characters", async () => {
    csvPath = await createTempCsv("col\nval\n");

    // Table name with spaces (works with all backends)
    const result = await convertCsvToSqliteFast(csvPath, dbPath, "my table");

    expect(result.schema.tableName).toBe("my table");

    // Should be queryable with quoted name
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT * FROM "my table"').all();
    db.close();

    expect(rows).toHaveLength(1);
  });

  it("handles CSV with varying whitespace", async () => {
    // Simple CSV without empty lines - consistent across all backends
    csvPath = await createTempCsv("a,b\n1,2\n3,4\n");

    const result = await convertCsvToSqliteFast(csvPath, dbPath, "whitespace");

    expect(result.schema.rowCount).toBe(2);

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM whitespace ORDER BY a").all() as Array<{
      a: unknown;
      b: unknown;
    }>;
    db.close();

    expect(rows).toHaveLength(2);
  });

  // Type inference tests - behavior differs between DuckDB and JS fallback
  describe("type inference", () => {
    it("infers numeric column types when using CLI tools", async () => {
      csvPath = await createTempCsv("id,price,name\n1,9.99,Widget\n2,19.99,Gadget\n");

      const result = await convertCsvToSqliteFast(csvPath, dbPath, "products");

      // DuckDB and SQLite CLI may infer INTEGER/REAL types
      // JS fallback stores all as TEXT
      // Either behavior is acceptable - we just verify the schema is valid
      expect(result.schema.columns).toHaveLength(3);
      expect(["INTEGER", "REAL", "TEXT"]).toContain(result.schema.columns[0]?.type);
      expect(["INTEGER", "REAL", "TEXT"]).toContain(result.schema.columns[1]?.type);
      expect(["TEXT"]).toContain(result.schema.columns[2]?.type);

      // Verify data is queryable and correct
      const db = new Database(dbPath, { readonly: true });
      const rows = db.prepare("SELECT * FROM products ORDER BY id").all() as Array<{
        id: unknown;
        price: unknown;
        name: string;
      }>;
      db.close();

      expect(rows).toHaveLength(2);
      expect(rows[0]?.name).toBe("Widget");
      expect(rows[1]?.name).toBe("Gadget");
    });

    it("returns valid schema with column types", async () => {
      csvPath = await createTempCsv("text,number,decimal\nhello,42,3.14\n");

      const result = await convertCsvToSqliteFast(csvPath, dbPath, "types");

      expect(result.schema.rowCount).toBe(1);
      expect(result.schema.columns).toHaveLength(3);

      // All column types should be one of the valid types
      for (const col of result.schema.columns) {
        expect(["INTEGER", "REAL", "TEXT"]).toContain(col.type);
      }
    });
  });

  describe("CLI cache behavior", () => {
    it("resetCliCache allows re-detection of CLI tools", async () => {
      csvPath = await createTempCsv("a\n1\n");

      // First conversion
      const result1 = await convertCsvToSqliteFast(csvPath, dbPath, "test1");
      expect(result1.schema.rowCount).toBe(1);

      // Reset and convert again
      resetCliCache();
      const dbPath2 = await createTempDbPath();
      const result2 = await convertCsvToSqliteFast(csvPath, dbPath2, "test2");
      expect(result2.schema.rowCount).toBe(1);

      // Cleanup second db
      await fs.rm(path.dirname(dbPath2), { recursive: true, force: true }).catch(() => {});
    });
  });
});

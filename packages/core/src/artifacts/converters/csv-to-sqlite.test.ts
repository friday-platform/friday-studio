/**
 * CSV to SQLite Converter Tests
 *
 * Tests streaming CSV conversion to SQLite database.
 * Follows TDD: each test written before implementation.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "@db/sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { convertCsvToSqlite } from "./csv-to-sqlite.ts";

/**
 * Create a temp CSV file with given content
 */
async function createTempCsv(content: string): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "csv-test-"));
  const csvPath = path.join(tempDir, "test.csv");
  await fs.writeFile(csvPath, content, "utf-8");
  return csvPath;
}

/**
 * Create a temp output path for SQLite database
 */
async function createTempDbPath(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "db-test-"));
  return path.join(tempDir, "output.db");
}

describe("convertCsvToSqlite", () => {
  let csvPath: string;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = await createTempDbPath();
  });

  afterEach(async () => {
    // Cleanup temp files
    if (csvPath) {
      try {
        await fs.unlink(csvPath);
        await fs.rmdir(path.dirname(csvPath));
      } catch {
        // Ignore cleanup errors
      }
    }
    if (dbPath) {
      try {
        await fs.unlink(dbPath);
        await fs.rmdir(path.dirname(dbPath));
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  it("converts simple CSV to SQLite database", async () => {
    csvPath = await createTempCsv("name,age\nAlice,30\nBob,25\n");

    const result = await convertCsvToSqlite(csvPath, dbPath, "users");

    expect(result.dbPath).toBe(dbPath);
    expect(result.schema.tableName).toBe("users");
    expect(result.schema.rowCount).toBe(2);
    expect(result.schema.columns).toHaveLength(2);
    expect(result.schema.columns[0]?.name).toBe("name");
    expect(result.schema.columns[1]?.name).toBe("age");

    // Verify database content
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM users").all() as Array<{ name: string; age: string }>;
    db.close();

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ name: "Alice", age: "30" });
    expect(rows[1]).toEqual({ name: "Bob", age: "25" });
  });

  it("stores all values as TEXT type", async () => {
    csvPath = await createTempCsv("id,value\n1,hello\n2,world\n");

    const result = await convertCsvToSqlite(csvPath, dbPath, "data");

    expect(result.schema.columns.every((col) => col.type === "TEXT")).toBe(true);
  });

  it("handles columns with special characters", async () => {
    csvPath = await createTempCsv('"Column ""A""",Column B\nvalue1,value2\n');

    const result = await convertCsvToSqlite(csvPath, dbPath, "special");

    expect(result.schema.columns[0]?.name).toBe('Column "A"');
    expect(result.schema.columns[1]?.name).toBe("Column B");

    // Verify can query the table using rowid to avoid column name issues
    const db = new Database(dbPath, { readonly: true });
    const count = db.prepare("SELECT COUNT(*) as cnt FROM special").get() as { cnt: number };
    db.close();

    expect(count.cnt).toBe(1);
  });

  it("handles empty column values", async () => {
    csvPath = await createTempCsv("a,b,c\n1,,3\n,2,\n");

    const result = await convertCsvToSqlite(csvPath, dbPath, "sparse");

    expect(result.schema.rowCount).toBe(2);

    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT * FROM sparse").all() as Array<{
      a: string | null;
      b: string | null;
      c: string | null;
    }>;
    db.close();

    expect(rows[0]?.b).toBe(null);
    expect(rows[1]?.a).toBe(null);
    expect(rows[1]?.c).toBe(null);
  });

  it("rejects empty CSV files", async () => {
    csvPath = await createTempCsv("");

    await expect(convertCsvToSqlite(csvPath, dbPath, "empty")).rejects.toThrow(
      /empty|no valid rows/i,
    );
  });

  it("rejects CSV with only headers", async () => {
    csvPath = await createTempCsv("name,age\n");

    await expect(convertCsvToSqlite(csvPath, dbPath, "headers_only")).rejects.toThrow(
      /empty|no valid rows/i,
    );
  });

  it("cleans up partial db file on error", async () => {
    // Create a CSV path that doesn't exist to trigger an error
    const nonExistentPath = "/tmp/nonexistent-csv-12345.csv";

    await expect(convertCsvToSqlite(nonExistentPath, dbPath, "fail")).rejects.toThrow();

    // Verify no partial db file was left behind
    const dbExists = await fs
      .access(dbPath)
      .then(() => true)
      .catch(() => false);
    expect(dbExists).toBe(false);
  });

  it("handles large CSV in batches without loading into memory", async () => {
    // Generate CSV with 10,000 rows (more than batch size of 5000)
    const header = "id,value\n";
    const rows = Array.from({ length: 10000 }, (_, i) => `${i},value_${i}`).join("\n");
    csvPath = await createTempCsv(header + rows);

    const result = await convertCsvToSqlite(csvPath, dbPath, "large");

    expect(result.schema.rowCount).toBe(10000);

    // Spot check some rows
    const db = new Database(dbPath, { readonly: true });
    const count = db.prepare("SELECT COUNT(*) as cnt FROM large").get() as { cnt: number };
    const first = db.prepare("SELECT * FROM large WHERE id = '0'").get() as {
      id: string;
      value: string;
    };
    const last = db.prepare("SELECT * FROM large WHERE id = '9999'").get() as {
      id: string;
      value: string;
    };
    db.close();

    expect(count.cnt).toBe(10000);
    expect(first.value).toBe("value_0");
    expect(last.value).toBe("value_9999");
  });

  it("handles CSV with various data types", async () => {
    csvPath = await createTempCsv(
      "text,number,decimal,bool_true,bool_false,empty\nhello,42,3.14,true,false,\n",
    );

    const result = await convertCsvToSqlite(csvPath, dbPath, "types");

    expect(result.schema.rowCount).toBe(1);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT * FROM types").get() as Record<string, unknown>;
    db.close();

    // All stored as text since we use TEXT columns
    expect(row.text).toBe("hello");
    expect(row.number).toBe("42");
    expect(row.decimal).toBe("3.14");
    expect(row.bool_true).toBe("true");
    expect(row.bool_false).toBe("false");
    expect(row.empty).toBe(null);
  });

  it("skips empty lines in CSV", async () => {
    csvPath = await createTempCsv("a,b\n1,2\n\n3,4\n\n\n");

    const result = await convertCsvToSqlite(csvPath, dbPath, "skipempty");

    expect(result.schema.rowCount).toBe(2);
  });

  it("sanitizes table name with quotes", async () => {
    csvPath = await createTempCsv("col\nval\n");

    // Table name with special characters that need escaping
    const result = await convertCsvToSqlite(csvPath, dbPath, 'my"table');

    expect(result.schema.tableName).toBe('my"table');

    // Should be queryable
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare('SELECT * FROM "my""table"').all();
    db.close();

    expect(rows).toHaveLength(1);
  });
});

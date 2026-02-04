import { Database } from "@db/sqlite";
import { describe, expect, test } from "vitest";
import { executeReadOnlyQuery, type QueryExecution } from "./sql-tools.ts";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
  db.exec("INSERT INTO users (name) VALUES ('alice'), ('bob')");
  return db;
}

describe("executeReadOnlyQuery", () => {
  test("allows SELECT queries", () => {
    const db = createTestDb();
    const queryLog: QueryExecution[] = [];

    const result = executeReadOnlyQuery(db, "SELECT * FROM users", "execute_sql", queryLog);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.rows).toHaveLength(2);
    }
  });

  test("allows CTE (WITH clause) queries", () => {
    const db = createTestDb();
    const queryLog: QueryExecution[] = [];

    const result = executeReadOnlyQuery(
      db,
      `WITH active_users AS (
        SELECT * FROM users WHERE name = 'alice'
      )
      SELECT * FROM active_users`,
      "execute_sql",
      queryLog,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.rows).toHaveLength(1);
    }
  });

  test("rejects INSERT queries", () => {
    const db = createTestDb();
    const queryLog: QueryExecution[] = [];

    const result = executeReadOnlyQuery(
      db,
      "INSERT INTO users (name) VALUES ('eve')",
      "execute_sql",
      queryLog,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Only read-only queries are allowed");
    }
  });

  test("rejects DELETE queries", () => {
    const db = createTestDb();
    const queryLog: QueryExecution[] = [];

    const result = executeReadOnlyQuery(db, "DELETE FROM users", "execute_sql", queryLog);

    expect(result.success).toBe(false);
  });

  test("rejects DROP queries", () => {
    const db = createTestDb();
    const queryLog: QueryExecution[] = [];

    const result = executeReadOnlyQuery(db, "DROP TABLE users", "execute_sql", queryLog);

    expect(result.success).toBe(false);
  });

  test("rejects CTE with mutating subquery (DELETE RETURNING)", () => {
    const db = createTestDb();
    const queryLog: QueryExecution[] = [];

    // This starts with WITH but contains a DELETE - rejected at parse time
    const result = executeReadOnlyQuery(
      db,
      `WITH deleted AS (
        DELETE FROM users WHERE name = 'alice' RETURNING *
      )
      SELECT * FROM deleted`,
      "execute_sql",
      queryLog,
    );

    expect(result.success).toBe(false);
    // Verify data wasn't actually deleted
    const remaining = db.prepare("SELECT COUNT(*) as count FROM users").get<{ count: number }>();
    expect(remaining?.count).toBe(2);
  });

  test("rejects UPDATE queries", () => {
    const db = createTestDb();
    const queryLog: QueryExecution[] = [];

    const result = executeReadOnlyQuery(
      db,
      "UPDATE users SET name = 'evil' WHERE id = 1",
      "execute_sql",
      queryLog,
    );

    expect(result.success).toBe(false);
  });

  test("returns error for invalid SQL syntax", () => {
    const db = createTestDb();
    const queryLog: QueryExecution[] = [];

    const result = executeReadOnlyQuery(db, "SELECT * FROM", "execute_sql", queryLog);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  });

  test("returns error for nonexistent table", () => {
    const db = createTestDb();
    const queryLog: QueryExecution[] = [];

    const result = executeReadOnlyQuery(db, "SELECT * FROM nonexistent", "execute_sql", queryLog);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("no such table");
    }
  });

  test("only executes first statement when semicolon-separated (SQLite limitation)", () => {
    const db = createTestDb();
    const queryLog: QueryExecution[] = [];

    // SQLite's prepare() only prepares the first statement.
    // The DELETE is silently ignored - this is safe but potentially confusing.
    const result = executeReadOnlyQuery(
      db,
      "SELECT * FROM users; DELETE FROM users",
      "execute_sql",
      queryLog,
    );

    expect(result.success).toBe(true);
    // Verify DELETE was NOT executed
    const count = db.prepare("SELECT COUNT(*) as c FROM users").get<{ c: number }>();
    expect(count?.c).toBe(2);
  });
});

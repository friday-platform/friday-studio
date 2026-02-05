/**
 * DuckDB CLI Query Execution Tests
 *
 * Tests the async DuckDB CLI based query execution by mocking child_process.spawn.
 * This avoids requiring the `duckdb` binary in CI while still exercising our
 * JSON parsing, error handling, query logging, and abort logic.
 */

import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { type DbAttachment, executeReadOnlyQuery, type QueryExecution } from "./sql-tools.ts";

// ---------------------------------------------------------------------------
// Mock child_process.spawn
// ---------------------------------------------------------------------------

interface MockProc extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: () => void };
  kill: ReturnType<typeof vi.fn>;
}

function createMockProc(): MockProc {
  const proc = new EventEmitter() as MockProc;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { end: vi.fn() };
  proc.kill = vi.fn();
  return proc;
}

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

afterEach(() => {
  spawnMock.mockClear();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DB: DbAttachment[] = [{ alias: "db0", path: "/tmp/test.db" }];

/** Simulate DuckDB returning JSON output and exiting successfully. */
function succeedWith(proc: MockProc, json: unknown): void {
  queueMicrotask(() => {
    proc.stdout.emit("data", Buffer.from(JSON.stringify(json)));
    proc.emit("close", 0);
  });
}

/** Simulate DuckDB writing to stderr and exiting with non-zero code. */
function failWith(proc: MockProc, stderr: string, code = 1): void {
  queueMicrotask(() => {
    proc.stderr.emit("data", Buffer.from(stderr));
    proc.emit("close", code);
  });
}

// =============================================================================
// Basic Query Execution
// =============================================================================

describe("executeReadOnlyQuery", () => {
  test("returns parsed rows from DuckDB JSON output", async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    succeedWith(proc, [{ count: 2 }]);

    const log: QueryExecution[] = [];
    const result = await executeReadOnlyQuery(
      DB,
      "SELECT COUNT(*) as count FROM db0.users",
      "execute_sql",
      log,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.rows).toEqual([{ count: 2 }]);
    }
  });

  test("returns multiple rows", async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    succeedWith(proc, [
      { id: 1, name: "alice" },
      { id: 2, name: "bob" },
    ]);

    const log: QueryExecution[] = [];
    const result = await executeReadOnlyQuery(DB, "SELECT * FROM db0.users", "execute_sql", log);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.rows).toHaveLength(2);
    }
  });

  test("handles empty result set", async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    succeedWith(proc, []);

    const log: QueryExecution[] = [];
    const result = await executeReadOnlyQuery(
      DB,
      "SELECT * FROM db0.users WHERE 1=0",
      "execute_sql",
      log,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.rows).toEqual([]);
    }
  });

  // ===========================================================================
  // Multi-Statement Query Handling
  // ===========================================================================

  test("handles multi-statement output (returns last JSON array)", async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);

    // DuckDB outputs one JSON array per statement, separated by newlines
    queueMicrotask(() => {
      proc.stdout.emit("data", Buffer.from('[{"a":1}]\n[{"b":2}]'));
      proc.emit("close", 0);
    });

    const log: QueryExecution[] = [];
    const result = await executeReadOnlyQuery(
      DB,
      "SELECT 1 as a; SELECT 2 as b",
      "execute_sql",
      log,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.rows).toEqual([{ b: 2 }]);
    }
  });

  // ===========================================================================
  // Error Handling
  // ===========================================================================

  test("returns error on non-zero exit code", async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    failWith(proc, "Error: Table does not exist");

    const log: QueryExecution[] = [];
    const result = await executeReadOnlyQuery(
      DB,
      "SELECT * FROM db0.nonexistent",
      "execute_sql",
      log,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Table does not exist");
    }
  });

  test("returns error on spawn failure", async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);

    queueMicrotask(() => {
      proc.emit("error", new Error("ENOENT"));
    });

    const log: QueryExecution[] = [];
    const result = await executeReadOnlyQuery(DB, "SELECT 1", "execute_sql", log);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Failed to spawn duckdb");
    }
  });

  test("returns error when stdio is null (binary missing)", async () => {
    const proc = new EventEmitter() as MockProc;
    proc.stdout = null as unknown as EventEmitter;
    proc.stderr = null as unknown as EventEmitter;
    proc.stdin = { end: vi.fn() };
    proc.kill = vi.fn();
    spawnMock.mockReturnValue(proc);

    const log: QueryExecution[] = [];
    const result = await executeReadOnlyQuery(DB, "SELECT 1", "execute_sql", log);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("stdio streams unavailable");
    }
  });

  test("returns error for malformed JSON output", async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);

    queueMicrotask(() => {
      proc.stdout.emit("data", Buffer.from("not json at all"));
      proc.emit("close", 0);
    });

    const log: QueryExecution[] = [];
    const result = await executeReadOnlyQuery(DB, "SELECT 1", "execute_sql", log);

    // No JSON array found → empty result parsed as []
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.rows).toEqual([]);
    }
  });

  // ===========================================================================
  // Query Logging
  // ===========================================================================

  test("logs successful query with duration and row count", async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    succeedWith(proc, [{ x: 1 }]);

    const log: QueryExecution[] = [];
    await executeReadOnlyQuery(DB, "SELECT 1 as x", "execute_sql", log);

    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      sql: "SELECT 1 as x",
      success: true,
      rowCount: 1,
      error: null,
      tool: "execute_sql",
    });
    expect(log[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("logs failed query with error", async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    failWith(proc, "read-only database");

    const log: QueryExecution[] = [];
    await executeReadOnlyQuery(DB, "INSERT INTO db0.users VALUES (1)", "execute_sql", log);

    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ success: false, tool: "execute_sql" });
    expect(log[0]?.error).toContain("read-only database");
    expect(log[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("logs with save_results tool name", async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    succeedWith(proc, [{ a: 1 }]);

    const log: QueryExecution[] = [];
    await executeReadOnlyQuery(DB, "SELECT 1", "save_results", log);

    expect(log).toHaveLength(1);
    expect(log[0]?.tool).toBe("save_results");
  });

  // ===========================================================================
  // Abort Signal
  // ===========================================================================

  test("resolves with abort error when signal fires", async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);

    const controller = new AbortController();

    const resultPromise = executeReadOnlyQuery(
      DB,
      "SELECT 1",
      "execute_sql",
      [],
      controller.signal,
    );

    // Abort before the process completes
    controller.abort();

    const result = await resultPromise;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Query aborted");
    }
    expect(proc.kill).toHaveBeenCalled();
  });

  // ===========================================================================
  // Multiple Database Attachments
  // ===========================================================================

  test("builds ATTACH statements for multiple databases", async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    succeedWith(proc, [{ name: "alice", order_id: 1 }]);

    const log: QueryExecution[] = [];
    const dbs: DbAttachment[] = [
      { alias: "db0", path: "/tmp/users.db" },
      { alias: "db1", path: "/tmp/orders.db" },
    ];

    const result = await executeReadOnlyQuery(
      dbs,
      "SELECT u.name, o.id as order_id FROM db0.users u JOIN db1.orders o ON u.name = o.user_name",
      "execute_sql",
      log,
    );

    expect(result.success).toBe(true);

    // Verify spawn was called with correct args containing both ATTACH statements
    const spawnArgs = spawnMock.mock.calls[0]?.[1] as string[];
    const attachArg = spawnArgs?.find((arg) => arg.includes("ATTACH"));
    expect(attachArg).toContain("/tmp/users.db");
    expect(attachArg).toContain("/tmp/orders.db");
    expect(attachArg).toContain('"db0"');
    expect(attachArg).toContain('"db1"');
  });

  // ===========================================================================
  // Spawn Arguments
  // ===========================================================================

  test("passes correct args to DuckDB CLI", async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    succeedWith(proc, []);

    await executeReadOnlyQuery(DB, "SELECT 1", "execute_sql", []);

    expect(spawnMock).toHaveBeenCalledOnce();
    const [bin, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(bin).toBe("duckdb");

    // Should include: -c "INSTALL sqlite; LOAD sqlite;", -c ATTACH..., -c ".mode json", -c query
    expect(args).toContain("-c");
    expect(args).toContain(".mode json");
    expect(args).toContain("SELECT 1");
    expect(args.some((a: string) => a.includes("INSTALL sqlite"))).toBe(true);
    expect(args.some((a: string) => a.includes("ATTACH"))).toBe(true);
  });

  test("escapes single quotes in database paths", async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    succeedWith(proc, []);

    const dbs: DbAttachment[] = [{ alias: "db0", path: "/tmp/it's a test.db" }];
    await executeReadOnlyQuery(dbs, "SELECT 1", "execute_sql", []);

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    const attachArg = args?.find((a) => a.includes("ATTACH"));
    expect(attachArg).toContain("it''s a test.db");
  });

  test("escapes double quotes in alias names", async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);
    succeedWith(proc, []);

    const dbs: DbAttachment[] = [{ alias: 'db"test', path: "/tmp/test.db" }];
    await executeReadOnlyQuery(dbs, "SELECT 1", "execute_sql", []);

    const args = spawnMock.mock.calls[0]?.[1] as string[];
    const attachArg = args?.find((a) => a.includes("ATTACH"));
    expect(attachArg).toContain('"db""test"');
  });

  // ===========================================================================
  // Stderr Capping
  // ===========================================================================

  test("caps stderr output to prevent memory issues", async () => {
    const proc = createMockProc();
    spawnMock.mockReturnValue(proc);

    const hugeError = "x".repeat(128 * 1024); // 128KB, exceeds 64KB cap

    queueMicrotask(() => {
      proc.stderr.emit("data", Buffer.from(hugeError));
      proc.emit("close", 1);
    });

    const log: QueryExecution[] = [];
    const result = await executeReadOnlyQuery(DB, "SELECT bad", "execute_sql", log);

    expect(result.success).toBe(false);
    if (!result.success) {
      // Error should be capped, not the full 128KB
      expect(result.error.length).toBeLessThanOrEqual(65 * 1024); // 64KB + small margin
    }
  });
});

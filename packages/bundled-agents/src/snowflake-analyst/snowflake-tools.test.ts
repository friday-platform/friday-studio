/**
 * Tests for snowflake-tools: configFromEnv, executeReadOnlyQuery,
 * createExecuteSqlTool, createDescribeTableTool, classifyError.
 *
 * The implementation uses async execution (asyncExec: true) + status polling +
 * result streaming. Mocks reflect this three-phase pattern:
 *   1. connection.execute({ asyncExec: true }) → statement with queryId
 *   2. connection.getQueryStatusThrowIfError(queryId) → "SUCCESS"
 *   3. connection.getResultsFromQueryId({ queryId, streamResult: true }) → statement with streamRows()
 */

import { Readable } from "node:stream";
import type { Logger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock setup — vi.hoisted() ensures these are available at mock definition time
// ---------------------------------------------------------------------------

const {
  mockConnect,
  mockDestroy,
  mockExecute,
  mockGetQueryStatusThrowIfError,
  mockGetResultsFromQueryId,
  mockIsUp,
  mockIsTokenValid,
  mockIsValidAsync,
  mockErrorCode,
} = vi.hoisted(() => ({
  mockConnect: vi.fn(),
  mockDestroy: vi.fn(),
  mockExecute: vi.fn(),
  mockGetQueryStatusThrowIfError: vi.fn(),
  mockGetResultsFromQueryId: vi.fn(),
  mockIsUp: vi.fn<() => boolean>(),
  mockIsTokenValid: vi.fn<() => boolean>(),
  mockIsValidAsync: vi.fn<() => Promise<boolean>>(),
  mockErrorCode: {
    ERR_SF_RESPONSE_INVALID_TOKEN: 401004,
    ERR_SF_NETWORK_COULD_NOT_CONNECT: 401001,
    ERR_LARGE_RESULT_SET_NETWORK_COULD_NOT_CONNECT: 402001,
    ERR_SF_RESPONSE_FAILURE: 401002,
  },
}));

vi.mock("snowflake-sdk", () => ({
  default: {
    configure: vi.fn(),
    createConnection: vi.fn(() => ({
      connect: mockConnect,
      destroy: mockDestroy,
      execute: mockExecute,
      getQueryStatusThrowIfError: mockGetQueryStatusThrowIfError,
      getResultsFromQueryId: mockGetResultsFromQueryId,
      isUp: mockIsUp,
      isTokenValid: mockIsTokenValid,
      isValidAsync: mockIsValidAsync,
    })),
    ErrorCode: mockErrorCode,
  },
}));

import {
  classifyError,
  configFromEnv,
  createDescribeTableTool,
  createExecuteSqlTool,
  createSnowflakeConnection,
  destroySnowflakeConnection,
  executeReadOnlyQuery,
  type QueryExecution,
  validateConnection,
} from "./snowflake-tools.ts";

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
};

/** Minimal ToolCallOptions for test execute() calls. */
const toolCtx = { toolCallId: "test-call", messages: [] as never[] };

// ---------------------------------------------------------------------------
// Helpers to build mock statements and streams
// ---------------------------------------------------------------------------

/** Creates a Readable object-mode stream from an array of rows. */
function createRowStream(rows: Record<string, unknown>[]): Readable {
  return Readable.from(rows, { objectMode: true });
}

/** Builds a mock statement for the async execution pattern. */
function createMockStatement(opts: { queryId?: string; rows?: Record<string, unknown>[] } = {}) {
  const queryId = opts.queryId ?? "test-query-id";
  const rows = opts.rows ?? [];

  return {
    getQueryId: () => queryId,
    getNumRows: () => rows.length,
    streamRows: () => createRowStream(rows),
    cancel: vi.fn((cb: (err: Error | null) => void) => cb(null)),
    getColumns: vi.fn(),
  };
}

/**
 * Sets up mocks for a successful query: submit → poll → stream results.
 * Call this before each test that exercises executeReadOnlyQuery with valid SQL.
 */
function setupSuccessfulQuery(rows: Record<string, unknown>[], queryId = "test-query-id") {
  const submitStmt = createMockStatement({ queryId, rows: [] });
  const resultStmt = createMockStatement({ queryId, rows });

  mockExecute.mockImplementation(
    ({ complete }: { complete: (err: Error | null, stmt: unknown) => void }) => {
      complete(null, submitStmt);
    },
  );
  mockGetQueryStatusThrowIfError.mockResolvedValue("SUCCESS");
  mockGetResultsFromQueryId.mockResolvedValue(resultStmt);

  return { submitStmt, resultStmt };
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockConnect.mockReset();
  mockDestroy.mockReset();
  mockExecute.mockReset();
  mockGetQueryStatusThrowIfError.mockReset();
  mockGetResultsFromQueryId.mockReset();
  mockIsUp.mockReset();
  mockIsTokenValid.mockReset();
  mockIsValidAsync.mockReset();
  // Default: connect succeeds
  mockConnect.mockImplementation((cb: (err: Error | null) => void) => cb(null));
  // Default: destroy succeeds
  mockDestroy.mockImplementation((cb: (err: Error | null) => void) => cb(null));
  // Default: connection is healthy
  mockIsUp.mockReturnValue(true);
  mockIsTokenValid.mockReturnValue(true);
  mockIsValidAsync.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// configFromEnv
// ---------------------------------------------------------------------------

describe("configFromEnv", () => {
  test("extracts valid config from env", () => {
    const env = {
      SNOWFLAKE_ACCOUNT: "xy12345",
      SNOWFLAKE_USER: "admin",
      SNOWFLAKE_PASSWORD: "secret",
      SNOWFLAKE_WAREHOUSE: "COMPUTE_WH",
      SNOWFLAKE_ROLE: "ACCOUNTADMIN",
    };
    const config = configFromEnv(env);
    expect(config.account).toBe("xy12345");
    expect(config.username).toBe("admin");
    expect(config.password).toBe("secret");
    expect(config.warehouse).toBe("COMPUTE_WH");
    expect(config.role).toBe("ACCOUNTADMIN");
    expect(config.database).toBeUndefined();
    expect(config.schema).toBeUndefined();
  });

  test("includes optional database and schema", () => {
    const env = {
      SNOWFLAKE_ACCOUNT: "xy12345",
      SNOWFLAKE_USER: "admin",
      SNOWFLAKE_PASSWORD: "secret",
      SNOWFLAKE_WAREHOUSE: "WH",
      SNOWFLAKE_ROLE: "ROLE",
      SNOWFLAKE_DATABASE: "MY_DB",
      SNOWFLAKE_SCHEMA: "PUBLIC",
    };
    const config = configFromEnv(env);
    expect(config.database).toBe("MY_DB");
    expect(config.schema).toBe("PUBLIC");
  });

  test("throws on missing required fields", () => {
    const env = { SNOWFLAKE_ACCOUNT: "xy12345" };
    expect(() => configFromEnv(env)).toThrow();
  });

  test("throws on empty account", () => {
    const env = {
      SNOWFLAKE_ACCOUNT: "",
      SNOWFLAKE_USER: "admin",
      SNOWFLAKE_PASSWORD: "secret",
      SNOWFLAKE_WAREHOUSE: "WH",
      SNOWFLAKE_ROLE: "ROLE",
    };
    expect(() => configFromEnv(env)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// createSnowflakeConnection
// ---------------------------------------------------------------------------

describe("createSnowflakeConnection", () => {
  const validConfig = {
    account: "xy12345",
    username: "admin",
    password: "secret",
    warehouse: "WH",
    role: "ROLE",
  };

  test("resolves on successful connect", async () => {
    const conn = await createSnowflakeConnection(validConfig, mockLogger);
    expect(conn).toBeDefined();
    expect(mockConnect).toHaveBeenCalledOnce();
  });

  test("rejects on connection error", async () => {
    mockConnect.mockImplementation((cb: (err: Error | null) => void) =>
      cb(new Error("auth failed")),
    );
    await expect(createSnowflakeConnection(validConfig, mockLogger)).rejects.toThrow(
      "Snowflake connection failed: auth failed",
    );
  });

  test("rejects when post-connect health check fails", async () => {
    mockIsValidAsync.mockResolvedValue(false);
    await expect(createSnowflakeConnection(validConfig, mockLogger)).rejects.toThrow(
      "Snowflake post-connect validation failed",
    );
    expect(mockDestroy).toHaveBeenCalledOnce();
  });

  test("rejects with timeout when connect callback never fires", async () => {
    vi.useFakeTimers();
    // connect never calls its callback — simulates a hanging connection
    mockConnect.mockImplementation(() => {});

    const promise = createSnowflakeConnection(validConfig, mockLogger);
    // Attach rejection handler before advancing time to prevent unhandled rejection
    const caught = promise.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(10_000);

    const result = await caught;
    expect(result).toBeInstanceOf(Error);
    if (!(result instanceof Error)) throw new Error("unreachable");
    expect(result.message).toContain("Snowflake connection timed out after 10s");
    expect(mockDestroy).toHaveBeenCalledOnce();
    expect(mockLogger.error).toHaveBeenCalledWith(
      "Snowflake connection timed out",
      expect.objectContaining({ account: "xy12345" }),
    );
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// destroySnowflakeConnection
// ---------------------------------------------------------------------------

describe("destroySnowflakeConnection", () => {
  test("resolves on successful destroy", async () => {
    const conn = await createSnowflakeConnection(
      { account: "x", username: "u", password: "p", warehouse: "w", role: "r" },
      mockLogger,
    );
    await destroySnowflakeConnection(conn, mockLogger);
    expect(mockDestroy).toHaveBeenCalledOnce();
  });

  test("resolves even on destroy error (logs warning)", async () => {
    mockDestroy.mockImplementation((cb: (err: Error | null) => void) =>
      cb(new Error("destroy failed")),
    );
    const conn = await createSnowflakeConnection(
      { account: "x", username: "u", password: "p", warehouse: "w", role: "r" },
      mockLogger,
    );
    await destroySnowflakeConnection(conn, mockLogger);
    expect(mockLogger.warn).toHaveBeenCalledWith("Snowflake disconnect error", {
      error: "destroy failed",
    });
  });
});

// ---------------------------------------------------------------------------
// validateConnection
// ---------------------------------------------------------------------------

describe("validateConnection", () => {
  function getConnection() {
    return createSnowflakeConnection(
      { account: "x", username: "u", password: "p", warehouse: "w", role: "r" },
      mockLogger,
    );
  }

  test("returns null when connection is healthy", async () => {
    const conn = await getConnection();
    const result = await validateConnection(conn, mockLogger);
    expect(result).toBeNull();
  });

  test("returns error when isUp() is false", async () => {
    const conn = await getConnection();
    mockIsUp.mockReturnValue(false);
    const result = await validateConnection(conn, mockLogger);
    expect(result).toContain("no longer active");
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("connection is down"));
  });

  test("returns error when isTokenValid() is false", async () => {
    const conn = await getConnection();
    mockIsTokenValid.mockReturnValue(false);
    const result = await validateConnection(conn, mockLogger);
    expect(result).toContain("token has expired");
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("token expired"));
  });

  test("skips isTokenValid when method does not exist", async () => {
    // Create a connection without isTokenValid to test the typeof guard
    const conn = await getConnection();
    // Make isTokenValid not a function so typeof check fails
    Object.defineProperty(conn, "isTokenValid", { value: undefined, configurable: true });
    mockIsUp.mockReturnValue(true);
    const result = await validateConnection(conn, mockLogger);
    expect(result).toBeNull();
  });

  test("returns error when isValidAsync() fails with fullCheck", async () => {
    const conn = await getConnection();
    mockIsValidAsync.mockResolvedValue(false);
    const result = await validateConnection(conn, mockLogger, true);
    expect(result).toContain("failed health check");
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("heartbeat returned false"),
    );
  });

  test("skips heartbeat when fullCheck is false (default)", async () => {
    const conn = await getConnection();
    mockIsValidAsync.mockResolvedValue(false);
    // Reset after connection creation (which does a full check)
    mockIsValidAsync.mockClear();
    // Without fullCheck, isValidAsync is NOT called
    const result = await validateConnection(conn, mockLogger);
    expect(result).toBeNull();
    expect(mockIsValidAsync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

describe("classifyError", () => {
  test("classifies auth token errors", () => {
    const err = Object.assign(new Error("token expired"), { code: 401004 });
    const result = classifyError(err);
    expect(result.category).toBe("auth");
    expect(result.message).toContain("Authentication expired");
    expect(result.isFatal).toBe(true);
  });

  test("classifies network connection errors", () => {
    const err = Object.assign(new Error("cannot connect"), { code: 401001 });
    const result = classifyError(err);
    expect(result.category).toBe("network");
    expect(result.message).toContain("Network error");
  });

  test("classifies large result set network errors", () => {
    const err = Object.assign(new Error("download failed"), { code: 402001 });
    const result = classifyError(err);
    expect(result.category).toBe("network");
  });

  test("classifies server response failures", () => {
    const err = Object.assign(new Error("server error"), { code: 401002 });
    const result = classifyError(err);
    expect(result.category).toBe("network");
    expect(result.message).toContain("Server error");
  });

  test("classifies SQL errors by sqlState presence", () => {
    const err = Object.assign(new Error("syntax error"), { sqlState: "42000" });
    const result = classifyError(err);
    expect(result.category).toBe("sql");
    expect(result.isFatal).toBe(false);
  });

  test("classifies generic errors as internal", () => {
    const result = classifyError(new Error("something broke"));
    expect(result.category).toBe("internal");
    expect(result.isFatal).toBe(false);
  });

  test("handles non-Error values", () => {
    const result = classifyError("string error");
    expect(result.category).toBe("internal");
    expect(result.message).toBe("string error");
    expect(result.isFatal).toBe(false);
    expect(result.cause).toBeUndefined();
  });

  test("extracts isFatal from error", () => {
    const err = Object.assign(new Error("connection reset"), { isFatal: true });
    const result = classifyError(err);
    expect(result.isFatal).toBe(true);
  });

  test("extracts cause message from error chain", () => {
    const root = new Error("TCP reset");
    const mid = Object.assign(new Error("connection lost"), { cause: root });
    const top = Object.assign(new Error("query failed"), { cause: mid });
    const result = classifyError(top);
    expect(result.cause).toBe("TCP reset");
  });

  test("handles single-level cause", () => {
    const cause = new Error("socket timeout");
    const err = Object.assign(new Error("network error"), { cause });
    const result = classifyError(err);
    expect(result.cause).toBe("socket timeout");
  });

  test("returns undefined cause when no cause chain", () => {
    const result = classifyError(new Error("no cause"));
    expect(result.cause).toBeUndefined();
  });

  test("handles circular cause chain without infinite loop", () => {
    const err1 = new Error("err1");
    const err2 = Object.assign(new Error("err2"), { cause: err1 });
    Object.assign(err1, { cause: err2 });
    const result = classifyError(err2);
    // Walks err2.cause→err1→err2(visited, stop). Deepest visited is err2.
    expect(result.cause).toBe("err2");
  });
});

// ---------------------------------------------------------------------------
// executeReadOnlyQuery
// ---------------------------------------------------------------------------

describe("executeReadOnlyQuery", () => {
  function getConn() {
    return createSnowflakeConnection(
      { account: "x", username: "u", password: "p", warehouse: "w", role: "r" },
      mockLogger,
    );
  }

  test("returns rows on successful query", async () => {
    const rows = [{ ID: 1, NAME: "test" }];
    setupSuccessfulQuery(rows);

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(
      conn,
      "SELECT 1 AS ID, 'test' AS NAME",
      queryLog,
      mockLogger,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.rows).toEqual(rows);
      expect(result.rowCount).toBe(1);
      expect(result.wasTruncated).toBe(false);
      expect(result.rowsRead).toBe(1);
    }
    expect(queryLog).toHaveLength(1);
    expect(queryLog[0]?.success).toBe(true);
  });

  test("returns error on query submission failure", async () => {
    mockExecute.mockImplementation(
      ({ complete }: { complete: (err: Error | null, stmt: unknown) => void }) => {
        complete(new Error("table not found"), {});
      },
    );

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(conn, "SELECT * FROM nope", queryLog, mockLogger);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("table not found");
    }
    expect(queryLog[0]?.success).toBe(false);
  });

  test("returns error on polling failure", async () => {
    const submitStmt = createMockStatement();
    mockExecute.mockImplementation(
      ({ complete }: { complete: (err: Error | null, stmt: unknown) => void }) => {
        complete(null, submitStmt);
      },
    );
    mockGetQueryStatusThrowIfError.mockRejectedValue(new Error("query failed with error"));

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(
      conn,
      "SELECT * FROM failing_table",
      queryLog,
      mockLogger,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("query failed with error");
    }
  });

  test("cancels statement on error", async () => {
    const submitStmt = createMockStatement();
    mockExecute.mockImplementation(
      ({ complete }: { complete: (err: Error | null, stmt: unknown) => void }) => {
        complete(null, submitStmt);
      },
    );
    mockGetQueryStatusThrowIfError.mockRejectedValue(new Error("failed"));

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    await executeReadOnlyQuery(conn, "SELECT 1", queryLog, mockLogger);

    expect(submitStmt.cancel).toHaveBeenCalled();
  });

  // -- SQL validation tests (unchanged behavior) --

  test("rejects write SQL immediately without executing", async () => {
    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(
      conn,
      "INSERT INTO table VALUES (1)",
      queryLog,
      mockLogger,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Write operations are not allowed");
    }
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("rejects DROP SQL", async () => {
    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(conn, "DROP TABLE my_table", queryLog, mockLogger);

    expect(result.success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("rejects CALL stored procedure", async () => {
    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(
      conn,
      "CALL SYSTEM$CANCEL_ALL_QUERIES()",
      queryLog,
      mockLogger,
    );

    expect(result.success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("rejects EXECUTE IMMEDIATE", async () => {
    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(
      conn,
      "EXECUTE IMMEDIATE 'DROP TABLE t'",
      queryLog,
      mockLogger,
    );

    expect(result.success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("rejects CTE-wrapped write operations", async () => {
    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(
      conn,
      "WITH x AS (SELECT 1) INSERT INTO t VALUES (1)",
      queryLog,
      mockLogger,
    );

    expect(result.success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("allows CTE with SELECT", async () => {
    setupSuccessfulQuery([{ X: 1 }]);

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(
      conn,
      "WITH cte AS (SELECT 1 AS X) SELECT * FROM cte",
      queryLog,
      mockLogger,
    );

    expect(result.success).toBe(true);
    expect(mockExecute).toHaveBeenCalledOnce();
  });

  test("rejects comment-prefixed write operations", async () => {
    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(
      conn,
      "/* bypass */ DROP TABLE my_table",
      queryLog,
      mockLogger,
    );

    expect(result.success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("rejects line-comment-prefixed write operations", async () => {
    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(
      conn,
      "-- harmless\nINSERT INTO t VALUES (1)",
      queryLog,
      mockLogger,
    );

    expect(result.success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("rejects PUT file staging", async () => {
    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(
      conn,
      "PUT file:///tmp/data @~staged",
      queryLog,
      mockLogger,
    );

    expect(result.success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("rejects USE ROLE escalation", async () => {
    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(conn, "USE ROLE SECURITYADMIN", queryLog, mockLogger);

    expect(result.success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("rejects semicolon statement stacking", async () => {
    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(conn, "SELECT 1; DROP TABLE t", queryLog, mockLogger);

    expect(result.success).toBe(false);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("allows trailing semicolon without stacking", async () => {
    setupSuccessfulQuery([{ X: 1 }]);

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(conn, "SELECT 1 AS X;", queryLog, mockLogger);

    expect(result.success).toBe(true);
    expect(mockExecute).toHaveBeenCalledOnce();
  });

  test("allows SHOW query", async () => {
    setupSuccessfulQuery([{ name: "TABLE1" }]);

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(
      conn,
      "SHOW TABLES IN SCHEMA DB.SCHEMA",
      queryLog,
      mockLogger,
    );

    expect(result.success).toBe(true);
    expect(mockExecute).toHaveBeenCalledOnce();
  });

  test("allows DESCRIBE query", async () => {
    setupSuccessfulQuery([{ name: "col1", type: "VARCHAR" }]);

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(
      conn,
      "DESCRIBE TABLE DB.SCHEMA.TABLE",
      queryLog,
      mockLogger,
    );

    expect(result.success).toBe(true);
    expect(mockExecute).toHaveBeenCalledOnce();
  });

  test("resolves with timeout error when query takes too long", async () => {
    vi.useFakeTimers();
    // Submit succeeds but polling never resolves
    const submitStmt = createMockStatement();
    mockExecute.mockImplementation(
      ({ complete }: { complete: (err: Error | null, stmt: unknown) => void }) => {
        complete(null, submitStmt);
      },
    );
    // Polling always returns RUNNING
    mockGetQueryStatusThrowIfError.mockResolvedValue("RUNNING");

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const promise = executeReadOnlyQuery(conn, "SELECT * FROM huge_table", queryLog, mockLogger);

    // Advance past the 10-minute timeout
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1000);
    const result = await promise;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Query timed out after 10 minutes");
    }
    expect(queryLog).toHaveLength(1);
    expect(queryLog[0]?.success).toBe(false);
    vi.useRealTimers();
  });

  test("truncates results exceeding MAX_RESULT_ROWS", async () => {
    const largeResultSet = Array.from({ length: 10_001 }, (_, i) => ({ ID: i }));
    setupSuccessfulQuery(largeResultSet);

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(
      conn,
      "SELECT * FROM big_table",
      queryLog,
      mockLogger,
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.wasTruncated).toBe(true);
      expect(result.rowCount).toBe(10_000);
      expect(result.rows).toHaveLength(10_000);
    }
  });

  test.each([
    ["GRANT ROLE SECURITYADMIN TO USER attacker", "GRANT"],
    ["ALTER TABLE t ADD COLUMN x INT", "ALTER TABLE"],
    ["CREATE TABLE t (id INT)", "CREATE TABLE"],
    ["TRUNCATE TABLE t", "TRUNCATE"],
    ["COPY INTO t FROM @stage", "COPY INTO"],
    ["REVOKE ROLE analyst FROM USER someone", "REVOKE"],
  ])("rejects dangerous Snowflake command: %s", async (sql) => {
    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(conn, sql, queryLog, mockLogger);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Write operations are not allowed");
    }
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("preserves string literals containing comment characters", async () => {
    setupSuccessfulQuery([{ X: "--" }]);

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(
      conn,
      "SELECT '--' AS X FROM t LIMIT 1",
      queryLog,
      mockLogger,
    );

    expect(result.success).toBe(true);
    expect(mockExecute).toHaveBeenCalledOnce();
  });

  test("preserves string literals containing block comment characters", async () => {
    setupSuccessfulQuery([{ X: "/* hello */" }]);

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(
      conn,
      "SELECT '/* hello */' AS X FROM t LIMIT 1",
      queryLog,
      mockLogger,
    );

    expect(result.success).toBe(true);
    expect(mockExecute).toHaveBeenCalledOnce();
  });

  test("preserves double-quoted identifiers containing semicolons", async () => {
    setupSuccessfulQuery([{ X: 1 }]);

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(
      conn,
      'SELECT * FROM "my;table" LIMIT 1',
      queryLog,
      mockLogger,
    );

    expect(result.success).toBe(true);
    expect(mockExecute).toHaveBeenCalledOnce();
  });

  test("preserves double-quoted identifiers containing comment characters", async () => {
    setupSuccessfulQuery([{ X: 1 }]);

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(
      conn,
      'SELECT * FROM "my--table" LIMIT 1',
      queryLog,
      mockLogger,
    );

    expect(result.success).toBe(true);
    expect(mockExecute).toHaveBeenCalledOnce();
  });

  test.each([
    ["WITH x AS (SELECT 1) CREATE TABLE t AS SELECT * FROM x", "CTE-wrapped CREATE TABLE"],
    [
      "WITH x AS (SELECT 1 AS col) COPY INTO @stage FROM (SELECT * FROM x)",
      "CTE-wrapped COPY INTO",
    ],
    ["WITH x AS (SELECT 1) DROP TABLE t", "CTE-wrapped DROP"],
    ["WITH x AS (SELECT 1) GRANT ROLE admin TO USER u", "CTE-wrapped GRANT"],
    ["WITH x AS (SELECT 1) ALTER TABLE t ADD COLUMN x INT", "CTE-wrapped ALTER"],
    ["WITH x AS (SELECT 1) TRUNCATE TABLE t", "CTE-wrapped TRUNCATE"],
    ["WITH x AS (SELECT 1) EXECUTE IMMEDIATE 'DROP TABLE t'", "CTE-wrapped EXECUTE"],
  ])("rejects CTE-wrapped DDL/DML: %s", async (sql) => {
    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(conn, sql, queryLog, mockLogger);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Write operations are not allowed");
    }
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("resolves with error on stream error", async () => {
    const submitStmt = createMockStatement();
    // Override streamRows to return a stream that emits an error
    const errorStream = new Readable({
      objectMode: true,
      read() {
        this.destroy(new Error("stream corruption"));
      },
    });
    const resultStmt = { ...createMockStatement(), streamRows: () => errorStream };

    mockExecute.mockImplementation(
      ({ complete }: { complete: (err: Error | null, stmt: unknown) => void }) => {
        complete(null, submitStmt);
      },
    );
    mockGetQueryStatusThrowIfError.mockResolvedValue("SUCCESS");
    mockGetResultsFromQueryId.mockResolvedValue(resultStmt);

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    const result = await executeReadOnlyQuery(conn, "SELECT 1", queryLog, mockLogger);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("stream corruption");
    }
    expect(queryLog).toHaveLength(1);
    expect(queryLog[0]?.success).toBe(false);
  });

  test("resolves with error on abort", async () => {
    // Submit succeeds but polling stays RUNNING
    const submitStmt = createMockStatement();
    mockExecute.mockImplementation(
      ({ complete }: { complete: (err: Error | null, stmt: unknown) => void }) => {
        complete(null, submitStmt);
      },
    );
    mockGetQueryStatusThrowIfError.mockResolvedValue("RUNNING");

    const queryLog: QueryExecution[] = [];
    const controller = new AbortController();
    const conn = await getConn();

    const promise = executeReadOnlyQuery(
      conn,
      "SELECT * FROM huge_table",
      queryLog,
      mockLogger,
      controller.signal,
    );

    // Abort after a microtask to let polling start
    await Promise.resolve();
    controller.abort();
    const result = await promise;

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe("Query aborted");
    }
  });

  test("passes asyncExec: true to connection.execute", async () => {
    setupSuccessfulQuery([]);

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    await executeReadOnlyQuery(conn, "SELECT 1", queryLog, mockLogger);

    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({ asyncExec: true, sqlText: "SELECT 1" }),
    );
  });

  test("passes streamResult: true to getResultsFromQueryId", async () => {
    setupSuccessfulQuery([{ X: 1 }]);

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    await executeReadOnlyQuery(conn, "SELECT 1", queryLog, mockLogger);

    expect(mockGetResultsFromQueryId).toHaveBeenCalledWith(
      expect.objectContaining({ streamResult: true }),
    );
  });

  test("passes requestId as UUID to connection.execute", async () => {
    setupSuccessfulQuery([]);

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    await executeReadOnlyQuery(conn, "SELECT 1", queryLog, mockLogger);

    const callArgs = mockExecute.mock.calls[0]?.[0];
    expect(callArgs.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("passes binds to connection.execute", async () => {
    setupSuccessfulQuery([{ ID: 1 }]);

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    await executeReadOnlyQuery(
      conn,
      "SELECT * FROM t WHERE id = ?",
      queryLog,
      mockLogger,
      undefined,
      [42],
    );

    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({ binds: [42] }));
  });

  test("omits binds when not provided", async () => {
    setupSuccessfulQuery([]);

    const queryLog: QueryExecution[] = [];
    const conn = await getConn();

    await executeReadOnlyQuery(conn, "SELECT 1", queryLog, mockLogger);

    const callArgs = mockExecute.mock.calls[0]?.[0];
    expect(callArgs.binds).toBeUndefined();
  });

  // ---- Pre-flight connection health checks ----

  test("returns error when connection is down (isUp false)", async () => {
    const conn = await getConn();
    mockIsUp.mockReturnValue(false);

    const queryLog: QueryExecution[] = [];
    const result = await executeReadOnlyQuery(conn, "SELECT 1", queryLog, mockLogger);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("no longer active");
    }
    expect(queryLog).toHaveLength(1);
    expect(queryLog[0]?.success).toBe(false);
    // Should NOT attempt to submit the query
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("returns error when token is expired (isTokenValid false)", async () => {
    const conn = await getConn();
    mockIsTokenValid.mockReturnValue(false);

    const queryLog: QueryExecution[] = [];
    const result = await executeReadOnlyQuery(conn, "SELECT 1", queryLog, mockLogger);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("token has expired");
    }
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("pre-flight check runs after SQL validation", async () => {
    const conn = await getConn();
    mockIsUp.mockReturnValue(false);

    const queryLog: QueryExecution[] = [];
    // Write SQL is rejected before pre-flight check runs
    const result = await executeReadOnlyQuery(conn, "DROP TABLE t", queryLog, mockLogger);

    expect(result.success).toBe(false);
    if (!result.success) {
      // SQL validation error, not connection health error
      expect(result.error).toContain("Write operations are not allowed");
    }
  });
});

// ---------------------------------------------------------------------------
// createExecuteSqlTool
// ---------------------------------------------------------------------------

describe("createExecuteSqlTool", () => {
  test("returns a tool with execute function", async () => {
    setupSuccessfulQuery([{ X: 1 }]);

    const queryLog: QueryExecution[] = [];
    const conn = await createSnowflakeConnection(
      { account: "x", username: "u", password: "p", warehouse: "w", role: "r" },
      mockLogger,
    );

    const sqlTool = createExecuteSqlTool(conn, mockLogger, queryLog);
    if (!sqlTool.execute) throw new Error("execute missing");

    const result = await sqlTool.execute({ sql: "SELECT 1 AS X" }, toolCtx);
    expect(result).toEqual({ success: true, rows: [{ X: 1 }], rowCount: 1, wasTruncated: false });
  });

  test("returns error for failed queries", async () => {
    mockExecute.mockImplementation(
      ({ complete }: { complete: (err: Error | null, stmt: unknown) => void }) => {
        complete(new Error("syntax error"), {});
      },
    );

    const queryLog: QueryExecution[] = [];
    const conn = await createSnowflakeConnection(
      { account: "x", username: "u", password: "p", warehouse: "w", role: "r" },
      mockLogger,
    );

    const sqlTool = createExecuteSqlTool(conn, mockLogger, queryLog);
    if (!sqlTool.execute) throw new Error("execute missing");
    const result = await sqlTool.execute({ sql: "SELECT INVALID SYNTAX" }, toolCtx);
    expect(result).toEqual({ success: false, error: "syntax error" });
  });

  test("passes bind parameters through to executeReadOnlyQuery", async () => {
    setupSuccessfulQuery([{ ID: 1, NAME: "test" }]);

    const queryLog: QueryExecution[] = [];
    const conn = await createSnowflakeConnection(
      { account: "x", username: "u", password: "p", warehouse: "w", role: "r" },
      mockLogger,
    );

    const sqlTool = createExecuteSqlTool(conn, mockLogger, queryLog);
    if (!sqlTool.execute) throw new Error("execute missing");

    await sqlTool.execute(
      { sql: "SELECT * FROM t WHERE id = ? AND name = ?", binds: [1, "test"] },
      toolCtx,
    );

    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({ binds: [1, "test"] }));
  });
});

// ---------------------------------------------------------------------------
// createDescribeTableTool
// ---------------------------------------------------------------------------

describe("createDescribeTableTool", () => {
  test("returns column metadata on success", async () => {
    const mockColumns = [
      {
        getName: () => "ID",
        getType: () => "NUMBER",
        isNullable: () => false,
        getScale: () => 0,
        getPrecision: () => 38,
      },
      {
        getName: () => "NAME",
        getType: () => "VARCHAR",
        isNullable: () => true,
        getScale: () => 0,
        getPrecision: () => 256,
      },
    ];

    mockExecute.mockImplementation(
      ({
        complete,
        describeOnly,
      }: {
        complete: (err: Error | null, stmt: unknown) => void;
        describeOnly: boolean;
      }) => {
        expect(describeOnly).toBe(true);
        complete(null, { getColumns: () => mockColumns });
      },
    );

    const conn = await createSnowflakeConnection(
      { account: "x", username: "u", password: "p", warehouse: "w", role: "r" },
      mockLogger,
    );

    const tool = createDescribeTableTool(conn, mockLogger);
    if (!tool.execute) throw new Error("execute missing");

    const result = await tool.execute({ table: "DB.SCHEMA.TABLE" }, toolCtx);
    expect(result).toEqual({
      success: true,
      columns: [
        { name: "ID", type: "NUMBER", nullable: false, scale: 0, precision: 38 },
        { name: "NAME", type: "VARCHAR", nullable: true, scale: 0, precision: 256 },
      ],
    });
  });

  test("returns error on describe failure", async () => {
    mockExecute.mockImplementation(
      ({ complete }: { complete: (err: Error | null, stmt: unknown) => void }) => {
        complete(new Error("table does not exist"), {});
      },
    );

    const conn = await createSnowflakeConnection(
      { account: "x", username: "u", password: "p", warehouse: "w", role: "r" },
      mockLogger,
    );

    const tool = createDescribeTableTool(conn, mockLogger);
    if (!tool.execute) throw new Error("execute missing");

    const result = await tool.execute({ table: "DB.SCHEMA.NOPE" }, toolCtx);
    expect(result).toEqual({ success: false, error: "table does not exist" });
  });

  test("rejects invalid table names", async () => {
    const conn = await createSnowflakeConnection(
      { account: "x", username: "u", password: "p", warehouse: "w", role: "r" },
      mockLogger,
    );

    const tool = createDescribeTableTool(conn, mockLogger);
    if (!tool.execute) throw new Error("execute missing");

    const result = await tool.execute({ table: "'; DROP TABLE t; --" }, toolCtx);
    expect(result).toEqual({
      success: false,
      error: "Invalid table name format. Use DB.SCHEMA.TABLE.",
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("rejects space-based SQL injection in table names", async () => {
    const conn = await createSnowflakeConnection(
      { account: "x", username: "u", password: "p", warehouse: "w", role: "r" },
      mockLogger,
    );

    const tool = createDescribeTableTool(conn, mockLogger);
    if (!tool.execute) throw new Error("execute missing");

    const result = await tool.execute(
      { table: "DB UNION SELECT secret_col FROM other_table" },
      toolCtx,
    );
    expect(result).toEqual({
      success: false,
      error: "Invalid table name format. Use DB.SCHEMA.TABLE.",
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  test("returns error when no columns available", async () => {
    mockExecute.mockImplementation(
      ({ complete }: { complete: (err: Error | null, stmt: unknown) => void }) => {
        complete(null, { getColumns: () => null });
      },
    );

    const conn = await createSnowflakeConnection(
      { account: "x", username: "u", password: "p", warehouse: "w", role: "r" },
      mockLogger,
    );

    const tool = createDescribeTableTool(conn, mockLogger);
    if (!tool.execute) throw new Error("execute missing");

    const result = await tool.execute({ table: "DB.SCHEMA.TABLE" }, toolCtx);
    expect(result).toEqual({ success: false, error: "No column metadata available" });
  });
});

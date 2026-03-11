/**
 * Direct Snowflake query execution via snowflake-sdk.
 * Replaces the MCP server indirection with native Node.js driver calls.
 *
 * Features:
 * - Streaming results (memory-safe for large result sets)
 * - Server-side statement cancellation via statement.cancel()
 * - Structured error classification (auth / network / sql / internal / fatal)
 * - Query tags for QUERY_HISTORY audit trail
 * - BigInt-safe integer handling
 * - Describe-only tool for fast schema introspection
 * - Parameter binding for SQL injection defense-in-depth
 * - Request ID for idempotent query submission
 * - fetchAsString for Date/JSON type safety
 * - Result prefetching for large result sets
 * - Pre-flight connection health checks (isUp, isTokenValid, isValidAsync)
 *
 * @module
 */

// Must be imported BEFORE snowflake-sdk — patches https.Agent for Deno compat.
// See deno-https-shim.ts for details.
import "./deno-https-shim.ts";

import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";

import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import snowflake from "snowflake-sdk";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const CONNECTION_TIMEOUT_MS = 10_000; // 10 seconds to establish connection
const QUERY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_RESULT_ROWS = 10_000;
/** Polling interval for async query status checks. */
const POLL_INTERVAL_MS = 500;

/** Allowlist of read-only SQL statement prefixes — defense-in-depth on top of prompt rules. */
const READ_ONLY_SQL_RE = /^\s*(SELECT|DESCRIBE|SHOW|EXPLAIN)\b/i;

/** WITH (CTE) is allowed only when the final statement is SELECT (not any write/DDL operation). */
const CTE_SELECT_RE = /^\s*WITH\b[\s\S]+\bSELECT\b/i;
const CTE_WRITE_RE =
  /^\s*WITH\b[\s\S]+\b(INSERT|UPDATE|DELETE|MERGE|CREATE|COPY|ALTER|DROP|GRANT|REVOKE|TRUNCATE|PUT|CALL|EXECUTE)\b/i;

/**
 * Strips SQL comments and blanks out quoted contents for security checking.
 * Comments are removed entirely. String literals ('...') and double-quoted
 * identifiers ("...") have their contents blanked (replaced with empty quotes)
 * so that semicolons, keywords, or comment characters inside quotes don't
 * trigger false positives in the stacking/allowlist checks.
 */
function stripSqlComments(sql: string): string {
  let result = "";
  let i = 0;
  while (i < sql.length) {
    // Single-quoted string literal — blank contents (SQL escapes ' as '')
    if (sql[i] === "'") {
      result += "''";
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
    }
    // Double-quoted identifier — blank contents (SQL escapes " as "")
    else if (sql[i] === '"') {
      result += '""';
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
    }
    // Line comment
    else if (sql[i] === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    }
    // Block comment
    else if (sql[i] === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      if (i < sql.length) i += 2;
    } else {
      result += sql[i];
      i++;
    }
  }
  return result;
}

/** Returns true if the (comment-stripped) SQL is a read-only statement. */
function isReadOnlySql(stripped: string): boolean {
  // Reject statement stacking — semicolons followed by another statement.
  if (/;\s*\S/.test(stripped)) return false;

  if (READ_ONLY_SQL_RE.test(stripped)) return true;
  // WITH (CTE) is read-only only if it ends with SELECT, not a write DML
  if (/^\s*WITH\b/i.test(stripped)) {
    return CTE_SELECT_RE.test(stripped) && !CTE_WRITE_RE.test(stripped);
  }
  return false;
}

// Global SDK config — executed once at import time (not per-connection).
// OCSP checks disabled: adds latency and Snowflake's OCSP endpoints are
// occasionally unreliable in containerized environments.
snowflake.configure({ logLevel: "WARN", disableOCSPChecks: true });

export const SnowflakeConnectionConfigSchema = z.object({
  account: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
  warehouse: z.string().min(1),
  role: z.string().min(1),
  database: z.string().optional(),
  schema: z.string().optional(),
});

export type SnowflakeConnectionConfig = z.infer<typeof SnowflakeConnectionConfigSchema>;

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export type ErrorCategory = "auth" | "network" | "sql" | "internal";

export interface ClassifiedError {
  message: string;
  category: ErrorCategory;
  /** True if the connection is no longer usable (requires reconnect). */
  isFatal: boolean;
  /** Root cause from the error's cause chain, if present. */
  cause: string | undefined;
}

/**
 * Classifies a Snowflake error into a category for structured logging
 * and potential retry/recovery decisions.
 *
 * Extracts `isFatal` (connection no longer usable) and `cause` (root cause
 * from the error chain) for richer diagnostics.
 */
export function classifyError(err: unknown): ClassifiedError {
  if (!(err instanceof Error)) {
    return { message: String(err), category: "internal", isFatal: false, cause: undefined };
  }

  // snowflake-sdk errors carry optional code, sqlState, isFatal, and cause
  const code = "code" in err && typeof err.code === "number" ? err.code : undefined;
  const sqlState = "sqlState" in err && typeof err.sqlState === "string" ? err.sqlState : undefined;
  const isFatal = "isFatal" in err && typeof err.isFatal === "boolean" ? err.isFatal : false;
  const cause = extractCauseMessage(err);

  if (code === snowflake.ErrorCode.ERR_SF_RESPONSE_INVALID_TOKEN) {
    return {
      message: `Authentication expired: ${err.message}`,
      category: "auth",
      isFatal: true,
      cause,
    };
  }
  if (
    code === snowflake.ErrorCode.ERR_SF_NETWORK_COULD_NOT_CONNECT ||
    code === snowflake.ErrorCode.ERR_LARGE_RESULT_SET_NETWORK_COULD_NOT_CONNECT
  ) {
    return { message: `Network error: ${err.message}`, category: "network", isFatal, cause };
  }
  if (code === snowflake.ErrorCode.ERR_SF_RESPONSE_FAILURE) {
    return { message: `Server error: ${err.message}`, category: "network", isFatal, cause };
  }
  if (sqlState) {
    return { message: err.message, category: "sql", isFatal: false, cause };
  }
  return { message: err.message, category: "internal", isFatal, cause };
}

/** Walks the error cause chain and returns the deepest cause message. */
function extractCauseMessage(err: Error): string | undefined {
  const visited = new Set<unknown>();
  let current: unknown = "cause" in err ? err.cause : undefined;
  let deepest: string | undefined;

  while (current instanceof Error && !visited.has(current)) {
    visited.add(current);
    deepest = current.message;
    current = "cause" in current ? current.cause : undefined;
  }

  return deepest;
}

// ---------------------------------------------------------------------------
// Connection health checks
// ---------------------------------------------------------------------------

/**
 * Validates that a Snowflake connection is healthy before submitting a query.
 * Three-tier check:
 * 1. isUp() — synchronous, checks internal connected state (zero cost)
 * 2. isTokenValid() — synchronous, checks session+master token expiration (zero network cost)
 * 3. isValidAsync() — async heartbeat to Snowflake server (one round-trip)
 *
 * Returns null if healthy, or an error string describing the failure.
 * Tier 3 (heartbeat) is optional — only called when `fullCheck` is true.
 */
export async function validateConnection(
  connection: snowflake.Connection,
  logger: Logger,
  fullCheck = false,
): Promise<string | null> {
  // Tier 1: synchronous state check
  if (!connection.isUp()) {
    logger.warn("Pre-flight check failed: connection is down");
    return "Snowflake connection is no longer active. The session may have been closed or timed out.";
  }

  // Tier 2: token expiration check (runtime-only method, not in type declarations)
  if ("isTokenValid" in connection && typeof connection.isTokenValid === "function") {
    const tokensValid: unknown = connection.isTokenValid();
    if (tokensValid === false) {
      logger.warn("Pre-flight check failed: session or master token expired");
      return "Snowflake session token has expired. Reconnection required.";
    }
  }

  // Tier 3: async heartbeat (network round-trip)
  if (fullCheck) {
    const valid = await connection.isValidAsync();
    if (!valid) {
      logger.warn("Pre-flight check failed: heartbeat returned false");
      return "Snowflake connection failed health check. The server may be unreachable.";
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Query tracking (shared schema with agent.ts)
// ---------------------------------------------------------------------------

export const QueryExecutionSchema = z.object({
  sql: z.string(),
  success: z.boolean(),
  rowCount: z.number().optional(),
  error: z.string().optional(),
  durationMs: z.number(),
});

export type QueryExecution = z.infer<typeof QueryExecutionSchema>;

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

/**
 * Creates and connects a Snowflake connection.
 * Uses promisified connect() — the SDK's callback API is wrapped for async/await.
 *
 * Features enabled:
 * - queryTag: tags all queries for QUERY_HISTORY audit trail
 * - jsTreatIntegerAsBigInt: prevents silent precision loss on 64-bit integers
 */
export function createSnowflakeConnection(
  config: SnowflakeConnectionConfig,
  logger: Logger,
): Promise<snowflake.Connection> {
  logger.info("Connecting to Snowflake", { account: config.account, warehouse: config.warehouse });

  const connection = snowflake.createConnection({
    account: config.account,
    username: config.username,
    password: config.password,
    warehouse: config.warehouse,
    role: config.role,
    database: config.database,
    schema: config.schema,
    application: "atlas-snowflake-analyst",
    clientSessionKeepAlive: true,
    clientSessionKeepAliveHeartbeatFrequency: 60,
    timeout: CONNECTION_TIMEOUT_MS,
    jsTreatIntegerAsBigInt: true,
    queryTag: "atlas-snowflake-analyst",
    // Serialize Date and JSON columns as strings to avoid timezone drift
    // and JSON.parse failures in the LLM context window.
    fetchAsString: ["Date", "JSON"],
    // Parallel chunk prefetching for large result sets (1-10 threads).
    resultPrefetch: 4,
    // Validate warehouse/role/database names at connect time — catches typos
    // before the first query instead of failing with cryptic SQL errors.
    validateDefaultParameters: true,
    // Rename duplicate column names from JOINs (e.g., a.id, b.id → ID, ID_2)
    // instead of silently dropping one. Default "object" mode overwrites dupes.
    rowMode: "object_with_renamed_duplicated_columns",
  });

  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.error("Snowflake connection timed out", {
        account: config.account,
        timeoutMs: CONNECTION_TIMEOUT_MS,
      });
      connection.destroy(() => {});
      reject(
        new Error(
          `Snowflake connection timed out after ${CONNECTION_TIMEOUT_MS / 1000}s — ` +
            `check that account "${config.account}" is correct and reachable.`,
        ),
      );
    }, CONNECTION_TIMEOUT_MS);

    connection.connect((connectErr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      if (connectErr) {
        logger.error("Snowflake connection failed", {
          account: config.account,
          error: connectErr.message,
        });
        reject(new Error(`Snowflake connection failed: ${connectErr.message}`));
        return;
      }

      // Post-connect validation: confirm the connection is truly healthy
      // before handing it to the analysis loop. Uses full check (heartbeat)
      // to catch edge cases where connect() succeeds but the session is invalid.
      validateConnection(connection, logger, true)
        .then((healthErr) => {
          if (healthErr) {
            logger.error("Post-connect health check failed", {
              account: config.account,
              healthErr,
            });
            connection.destroy(() => {});
            reject(new Error(`Snowflake post-connect validation failed: ${healthErr}`));
            return;
          }
          logger.info("Snowflake connection established", { account: config.account });
          resolve(connection);
        })
        .catch((validationErr) => {
          logger.error("Post-connect health check threw", {
            account: config.account,
            error: validationErr,
          });
          connection.destroy(() => {});
          reject(
            new Error(
              `Snowflake post-connect validation error: ${validationErr instanceof Error ? validationErr.message : String(validationErr)}`,
            ),
          );
        });
    });
  });
}

/**
 * Gracefully destroys a Snowflake connection.
 */
export function destroySnowflakeConnection(
  connection: snowflake.Connection,
  logger: Logger,
): Promise<void> {
  return new Promise((resolve) => {
    connection.destroy((destroyErr) => {
      if (destroyErr) {
        logger.warn("Snowflake disconnect error", { error: destroyErr.message });
      } else {
        logger.debug("Snowflake connection destroyed");
      }
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Async query helpers
// ---------------------------------------------------------------------------

type AnyStatement = snowflake.RowStatement | snowflake.FileAndStageBindStatement;

/** Query statuses that mean the query is still in progress. */
const STILL_RUNNING_STATUSES = new Set([
  "RUNNING",
  "ABORTING",
  "QUEUED",
  "RESUMING_WAREHOUSE",
  "QUEUED_REPARING_WAREHOUSE",
  "BLOCKED",
]);

/**
 * Submits a SQL query asynchronously. The returned statement has a queryId
 * that can be used to poll status and cancel the query server-side.
 *
 * Each submission gets a unique requestId for idempotent retries — if the
 * network drops and the SDK retries, Snowflake deduplicates by requestId
 * instead of running the query twice.
 */
function submitAsyncQuery(
  connection: snowflake.Connection,
  sql: string,
  binds?: snowflake.Bind[],
): Promise<AnyStatement> {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText: sql,
      asyncExec: true,
      requestId: randomUUID(),
      binds,
      complete: (err, stmt) => {
        if (err) reject(err);
        else resolve(stmt);
      },
    });
  });
}

/**
 * Polls Snowflake until the async query completes or the signal is aborted.
 * Throws on abort, query failure, or if the query enters an error state.
 */
async function pollForCompletion(
  connection: snowflake.Connection,
  queryId: string,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    // getQueryStatusThrowIfError throws on FAILED_WITH_ERROR, FAILED_WITH_INCIDENT, etc.
    const status = await connection.getQueryStatusThrowIfError(queryId);
    if (!STILL_RUNNING_STATUSES.has(status)) return;

    // Wait for poll interval or abort, whichever comes first
    await new Promise<void>((resolve) => {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, POLL_INTERVAL_MS);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  throw new Error("Query aborted");
}

/**
 * Collects rows from a statement's stream up to maxRows.
 * Destroys the stream early if the limit is exceeded (memory safety).
 */
function collectStreamedRows(
  statement: AnyStatement,
  maxRows: number,
): Promise<{ rows: Record<string, unknown>[]; wasTruncated: boolean; readCount: number }> {
  return new Promise((resolve, reject) => {
    const rows: Record<string, unknown>[] = [];
    let wasTruncated = false;
    let readCount = 0;
    let settled = false;

    const stream: Readable = statement.streamRows();

    function finish() {
      if (settled) return;
      settled = true;
      resolve({ rows, wasTruncated, readCount });
    }

    stream.on("data", (row: Record<string, unknown>) => {
      if (settled) return;
      readCount++;
      if (rows.length < maxRows) {
        rows.push(row);
      } else if (!wasTruncated) {
        wasTruncated = true;
        stream.destroy();
      }
    });

    stream.on("end", finish);
    stream.on("close", finish);
    stream.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------

type QueryResult =
  | {
      success: true;
      rows: Record<string, unknown>[];
      rowCount: number;
      rowsRead: number;
      wasTruncated: boolean;
      durationMs: number;
    }
  | { success: false; error: string; durationMs: number };

/**
 * Executes a read-only SQL query on Snowflake with:
 * - Async submission + polling (server-side cancellation on abort)
 * - Streaming result collection (memory-safe for large result sets)
 * - Structured error classification
 * - Query timing and audit logging
 */
export async function executeReadOnlyQuery(
  connection: snowflake.Connection,
  sql: string,
  queryLog: QueryExecution[],
  logger: Logger,
  abortSignal?: AbortSignal,
  binds?: snowflake.Bind[],
): Promise<QueryResult> {
  const start = performance.now();

  // Defense-in-depth: only allow read-only SQL (allowlist after stripping comments)
  const stripped = stripSqlComments(sql).trim();
  if (!isReadOnlySql(stripped)) {
    const durationMs = performance.now() - start;
    const error =
      "Write operations are not allowed. Only SELECT, DESCRIBE, SHOW, WITH, and EXPLAIN are permitted.";
    queryLog.push({ sql, success: false, error, durationMs });
    return { success: false, error, durationMs };
  }

  // Pre-flight: check connection health before submitting (fast, no network call)
  const healthError = await validateConnection(connection, logger);
  if (healthError) {
    const durationMs = performance.now() - start;
    queryLog.push({ sql, success: false, error: healthError, durationMs });
    return { success: false, error: healthError, durationMs };
  }

  // Combine external abort signal with our own timeout into a single controller
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);
  const onExternalAbort = () => controller.abort();
  abortSignal?.addEventListener("abort", onExternalAbort, { once: true });

  let statement: AnyStatement | undefined;

  try {
    // 1. Submit query asynchronously — returns immediately with queryId
    statement = await submitAsyncQuery(connection, sql, binds);
    const queryId = statement.getQueryId();
    logger.debug("Query submitted", { queryId, sql: sql.slice(0, 100) });

    // 2. Poll until query completes (respects abort + timeout)
    await pollForCompletion(connection, queryId, controller.signal);

    // 3. Fetch results with streaming — only downloads rows as needed
    const resultStmt = await connection.getResultsFromQueryId({ queryId, streamResult: true });

    // 4. Collect rows up to MAX_RESULT_ROWS (destroy stream early if exceeded)
    const { rows, wasTruncated, readCount } = await collectStreamedRows(
      resultStmt,
      MAX_RESULT_ROWS,
    );

    const durationMs = performance.now() - start;
    const rowCount = rows.length;
    const rowsRead = wasTruncated ? readCount : rowCount;

    queryLog.push({ sql, success: true, rowCount, durationMs });
    logger.debug("Snowflake query succeeded", {
      sql: sql.slice(0, 100),
      rowCount,
      rowsRead,
      wasTruncated,
      durationMs,
    });

    return { success: true, rows, rowCount, rowsRead, wasTruncated, durationMs };
  } catch (err) {
    // Cancel the query server-side if it's still running
    if (statement) {
      statement.cancel(() => {});
    }

    const durationMs = performance.now() - start;

    // Distinguish abort (user-initiated or timeout) from query errors
    if (controller.signal.aborted) {
      const isTimeout = !abortSignal?.aborted;
      const error = isTimeout ? "Query timed out after 10 minutes" : "Query aborted";
      queryLog.push({ sql, success: false, error, durationMs });
      logger.debug("Snowflake query cancelled", { sql: sql.slice(0, 100), error, durationMs });
      return { success: false, error, durationMs };
    }

    const classified = classifyError(err);
    queryLog.push({ sql, success: false, error: classified.message, durationMs });
    logger.debug("Snowflake query failed", {
      sql: sql.slice(0, 100),
      error: classified.message,
      category: classified.category,
      isFatal: classified.isFatal,
      cause: classified.cause,
      durationMs,
    });
    return { success: false, error: classified.message, durationMs };
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onExternalAbort);
  }
}

// ---------------------------------------------------------------------------
// AI SDK tool creation
// ---------------------------------------------------------------------------

type SqlExecuteResult =
  | { success: true; rows: Record<string, unknown>[]; rowCount: number; wasTruncated: boolean }
  | { success: false; error: string };

/**
 * Creates the execute_sql tool for the LLM analysis loop.
 *
 * Supports optional parameter binding via `binds` — the LLM can use `?`
 * placeholders in SQL and pass values separately, avoiding string
 * interpolation for user-supplied filter values.
 */
export function createExecuteSqlTool(
  connection: snowflake.Connection,
  logger: Logger,
  queryLog: QueryExecution[],
  abortSignal?: AbortSignal,
) {
  return tool({
    description:
      "Execute a read-only SQL query on Snowflake. " +
      "Use ? placeholders with the binds array for parameterized queries.",
    inputSchema: z.object({
      sql: z.string().describe("Read-only SQL query (use ? for bind placeholders)"),
      binds: z
        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe("Positional bind values for ? placeholders in the SQL"),
    }),
    execute: async ({ sql, binds }): Promise<SqlExecuteResult> => {
      const result = await executeReadOnlyQuery(
        connection,
        sql,
        queryLog,
        logger,
        abortSignal,
        binds,
      );
      if (!result.success) {
        return { success: false, error: result.error };
      }
      return {
        success: true,
        rows: result.rows,
        rowCount: result.rowCount,
        wasTruncated: result.wasTruncated,
      };
    },
  });
}

// ---------------------------------------------------------------------------
// Describe table tool
// ---------------------------------------------------------------------------

type ColumnInfo = {
  name: string;
  type: string;
  nullable: boolean;
  scale: number;
  precision: number;
};

type DescribeResult = { success: true; columns: ColumnInfo[] } | { success: false; error: string };

/** Validates table name to prevent SQL injection in describeOnly queries.
 * Allows 1-3 dot-separated segments, each either a quoted identifier or an unquoted identifier.
 * Spaces are NOT allowed outside quotes — prevents UNION/JOIN injection. */
const SAFE_TABLE_RE =
  /^(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))*$/;

/**
 * Creates the describe_table tool for fast schema introspection.
 * Uses describeOnly: true to get column metadata without executing a query.
 * Faster than DESCRIBE TABLE for the LLM's initial schema discovery step.
 */
export function createDescribeTableTool(connection: snowflake.Connection, logger: Logger) {
  return tool({
    description:
      "Get column metadata (name, type, nullable) for a Snowflake table without executing a query. " +
      "Faster than DESCRIBE TABLE. Use for initial schema discovery.",
    inputSchema: z.object({
      table: z.string().describe("Fully qualified table name (DB.SCHEMA.TABLE)"),
    }),
    execute: ({ table }): Promise<DescribeResult> => {
      if (!SAFE_TABLE_RE.test(table)) {
        return Promise.resolve({
          success: false,
          error: "Invalid table name format. Use DB.SCHEMA.TABLE.",
        });
      }

      return new Promise((resolve) => {
        connection.execute({
          sqlText: `SELECT * FROM ${table}`,
          describeOnly: true,
          complete: (err, stmt) => {
            if (err) {
              const classified = classifyError(err);
              logger.debug("Describe table failed", {
                table,
                error: classified.message,
                category: classified.category,
                isFatal: classified.isFatal,
                cause: classified.cause,
              });
              resolve({ success: false, error: classified.message });
              return;
            }

            const columns = stmt.getColumns();
            if (!columns) {
              resolve({ success: false, error: "No column metadata available" });
              return;
            }

            const columnInfo: ColumnInfo[] = columns.map((col) => ({
              name: col.getName(),
              type: col.getType(),
              nullable: col.isNullable(),
              scale: col.getScale(),
              precision: col.getPrecision(),
            }));

            logger.debug("Describe table succeeded", { table, columnCount: columnInfo.length });
            resolve({ success: true, columns: columnInfo });
          },
        });
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Config extraction from env
// ---------------------------------------------------------------------------

/**
 * Extracts and validates Snowflake connection config from resolved environment variables.
 * Throws on missing required fields via Zod parse.
 */
export function configFromEnv(env: Record<string, string>): SnowflakeConnectionConfig {
  return SnowflakeConnectionConfigSchema.parse({
    account: env.SNOWFLAKE_ACCOUNT,
    username: env.SNOWFLAKE_USER,
    password: env.SNOWFLAKE_PASSWORD,
    warehouse: env.SNOWFLAKE_WAREHOUSE,
    role: env.SNOWFLAKE_ROLE,
    database: env.SNOWFLAKE_DATABASE || undefined,
    schema: env.SNOWFLAKE_SCHEMA || undefined,
  });
}

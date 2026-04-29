import { spawn } from "node:child_process";
import process from "node:process";
import type { Logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";

const DUCKDB_PATH = process.env.FRIDAY_DUCKDB_PATH ?? "duckdb";
const QUERY_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_STDERR_BYTES = 64 * 1024; // 64KB cap on stderr

/** Schema for parsing DuckDB JSON output rows */
const QueryRowsSchema = z.array(z.record(z.string(), z.unknown()));

/** Record of an executed SQL query */
export const QueryExecutionSchema = z.object({
  sql: z.string(),
  success: z.boolean(),
  rowCount: z.number().optional(),
  error: z.string().optional(),
  durationMs: z.number(),
  tool: z.enum(["execute_sql", "save_results"]),
});

export type QueryExecution = z.infer<typeof QueryExecutionSchema>;

/** Database attachment for DuckDB queries */
export interface DbAttachment {
  alias: string;
  path: string;
}

type QueryResult =
  | { success: true; rows: Record<string, unknown>[]; durationMs: number }
  | { success: false; error: string; durationMs: number };

/**
 * Executes a read-only SQL query via DuckDB CLI against SQLite databases.
 * Uses DuckDB's SQLite extension with READ_ONLY attachment for security.
 */
export function executeReadOnlyQuery(
  databases: DbAttachment[],
  query: string,
  toolName: QueryExecution["tool"],
  queryLog: QueryExecution[],
  abortSignal?: AbortSignal,
): Promise<QueryResult> {
  const attachStatements = databases
    .map(({ alias, path }) => {
      const escapedPath = path.replace(/\\/g, "\\\\").replace(/'/g, "''");
      const sanitizedAlias = alias.replace(/"/g, '""');
      return `ATTACH '${escapedPath}' AS "${sanitizedAlias}" (TYPE sqlite, READ_ONLY true);`;
    })
    .join("\n");

  // Build command args - each statement as separate -c flag
  const args = [
    "-c",
    "INSTALL sqlite; LOAD sqlite;",
    "-c",
    attachStatements,
    "-c",
    ".mode json",
    "-c",
    query,
  ];

  const start = performance.now();

  return new Promise((resolve) => {
    const proc = spawn(DUCKDB_PATH, args, { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;

    // Deno's node:child_process compat may return null stdio when the binary is missing
    if (!proc.stdout || !proc.stderr) {
      const durationMs = performance.now() - start;
      const error = `Failed to spawn duckdb: stdio streams unavailable (is "${DUCKDB_PATH}" installed?)`;
      queryLog.push({ sql: query, success: false, error, durationMs, tool: toolName });
      resolve({ success: false, error, durationMs });
      return;
    }

    const cleanup = () => {
      if (!settled) {
        settled = true;
        proc.kill();
        clearTimeout(timeout);
      }
    };

    const timeout = setTimeout(() => {
      cleanup();
      const durationMs = performance.now() - start;
      queryLog.push({
        sql: query,
        success: false,
        error: "Query timed out",
        durationMs,
        tool: toolName,
      });
      resolve({ success: false, error: "Query timed out after 10 minutes", durationMs });
    }, QUERY_TIMEOUT_MS);

    // Handle abort signal
    abortSignal?.addEventListener(
      "abort",
      () => {
        cleanup();
        const durationMs = performance.now() - start;
        queryLog.push({
          sql: query,
          success: false,
          error: "Query aborted",
          durationMs,
          tool: toolName,
        });
        resolve({ success: false, error: "Query aborted", durationMs });
      },
      { once: true },
    );

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += data.toString().slice(0, MAX_STDERR_BYTES - stderr.length);
      }
    });

    proc.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const durationMs = performance.now() - start;
      const error = `Failed to spawn duckdb: ${err.message}`;
      queryLog.push({ sql: query, success: false, error, durationMs, tool: toolName });
      resolve({ success: false, error, durationMs });
    });

    proc.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      const durationMs = performance.now() - start;

      if (code !== 0) {
        const error = stderr || `DuckDB exited with code ${code}`;
        queryLog.push({ sql: query, success: false, error, durationMs, tool: toolName });
        resolve({ success: false, error, durationMs });
        return;
      }

      try {
        // DuckDB outputs one JSON array per statement. For multi-statement queries,
        // each result is separated by a newline. Arrays may span multiple lines.
        // Find all complete JSON arrays and take the last one.
        const jsonArrays: unknown[] = [];
        const trimmed = stdout.trim();

        // Find all JSON arrays (starting with [ and ending with ])
        let depth = 0;
        let arrayStart = -1;
        for (let i = 0; i < trimmed.length; i++) {
          if (trimmed[i] === "[") {
            if (depth === 0) arrayStart = i;
            depth++;
          } else if (trimmed[i] === "]") {
            depth--;
            if (depth === 0 && arrayStart !== -1) {
              jsonArrays.push(JSON.parse(trimmed.slice(arrayStart, i + 1)));
              arrayStart = -1;
            }
          }
        }

        const lastArray = jsonArrays[jsonArrays.length - 1] ?? [];
        const parseResult = QueryRowsSchema.safeParse(lastArray);

        if (!parseResult.success) {
          const error = `Failed to parse output: ${parseResult.error.message}`;
          queryLog.push({ sql: query, success: false, error, durationMs, tool: toolName });
          resolve({ success: false, error, durationMs });
          return;
        }

        queryLog.push({
          sql: query,
          success: true,
          rowCount: parseResult.data.length,
          durationMs,
          tool: toolName,
        });
        resolve({ success: true, rows: parseResult.data, durationMs });
      } catch (err) {
        const error = `Failed to parse output: ${err instanceof Error ? err.message : String(err)}`;
        queryLog.push({ sql: query, success: false, error, durationMs, tool: toolName });
        resolve({ success: false, error, durationMs });
      }
    });
  });
}

type SqlExecuteResult =
  | { success: true; rows: Record<string, unknown>[]; rowCount: number }
  | { success: false; error: string };

/**
 * Creates the execute_sql tool for LLM exploratory queries.
 */
export function createExecuteSqlTool(
  databases: DbAttachment[],
  logger: Logger,
  queryLog: QueryExecution[],
  abortSignal?: AbortSignal,
) {
  return tool({
    description: "Execute a read-only SQL query against the loaded data tables",
    inputSchema: z.object({ sql: z.string().describe("Read-only SQL query to execute") }),
    execute: async ({ sql }): Promise<SqlExecuteResult> => {
      const result = await executeReadOnlyQuery(
        databases,
        sql,
        "execute_sql",
        queryLog,
        abortSignal,
      );
      if (!result.success) {
        logger.debug("SQL execution failed", {
          sql,
          error: result.error,
          durationMs: result.durationMs,
        });
        return result;
      }
      logger.debug("SQL execution succeeded", {
        sql: sql.slice(0, 100),
        rowCount: result.rows.length,
        durationMs: result.durationMs,
      });
      return { success: true, rows: result.rows, rowCount: result.rows.length };
    },
  });
}

export type SavedResults = { rows: Record<string, unknown>[]; title: string };

type SaveResultsResult = { success: true; rowCount: number } | { success: false; error: string };

/**
 * Creates the save_results tool for persisting final query results.
 * Returns a tuple: [tool, getSavedResults]
 */
export function createSaveResultsTool(
  databases: DbAttachment[],
  queryLog: QueryExecution[],
  abortSignal?: AbortSignal,
) {
  let savedResults: SavedResults | null = null;

  const saveResultsTool = tool({
    description:
      "Save query results as the analysis output artifact. Call this once with your final results.",
    inputSchema: z.object({
      sql: z.string().describe("SQL query whose results should be saved"),
      title: z.string().describe("Title for the results artifact"),
    }),
    execute: async ({ sql, title }): Promise<SaveResultsResult> => {
      const result = await executeReadOnlyQuery(
        databases,
        sql,
        "save_results",
        queryLog,
        abortSignal,
      );
      if (!result.success) return result;
      savedResults = { rows: result.rows, title };
      return { success: true, rowCount: result.rows.length };
    },
  });

  return [saveResultsTool, () => savedResults] as const;
}

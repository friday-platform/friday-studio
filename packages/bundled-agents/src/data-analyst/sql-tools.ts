import type { Logger } from "@atlas/logger";
import type { Database } from "@db/sqlite";
import { tool } from "ai";
import { z } from "zod";

/** Record of an executed SQL query */
export const QueryExecutionSchema = z.object({
  sql: z.string(),
  success: z.boolean(),
  rowCount: z.number().nullable(),
  error: z.string().nullable(),
  durationMs: z.number(),
  tool: z.enum(["execute_sql", "save_results"]),
});

export type QueryExecution = z.infer<typeof QueryExecutionSchema>;

type QueryResult =
  | { success: true; rows: Record<string, unknown>[] }
  | { success: false; error: string };

/**
 * Validates, executes, and logs a read-only SQL query.
 * Rejects anything that isn't a SELECT statement.
 */
function executeReadOnlyQuery(
  db: Database,
  sql: string,
  toolName: QueryExecution["tool"],
  queryLog: QueryExecution[],
): QueryResult {
  const start = performance.now();

  const normalized = sql.trim().toUpperCase();
  if (!normalized.startsWith("SELECT")) {
    queryLog.push({
      sql,
      success: false,
      rowCount: null,
      error: "Only SELECT queries are allowed",
      durationMs: performance.now() - start,
      tool: toolName,
    });
    return { success: false, error: "Only SELECT queries are allowed" };
  }

  try {
    const rows = db.prepare(sql).all<Record<string, unknown>>();
    queryLog.push({
      sql,
      success: true,
      rowCount: rows.length,
      error: null,
      durationMs: performance.now() - start,
      tool: toolName,
    });
    return { success: true, rows };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    queryLog.push({
      sql,
      success: false,
      rowCount: null,
      error: msg,
      durationMs: performance.now() - start,
      tool: toolName,
    });
    return { success: false, error: msg };
  }
}

type SqlExecuteResult =
  | { success: true; rows: Record<string, unknown>[]; rowCount: number }
  | { success: false; error: string };

/**
 * Creates the execute_sql tool for LLM exploratory queries.
 */
export function createExecuteSqlTool(db: Database, logger: Logger, queryLog: QueryExecution[]) {
  return tool({
    description: "Execute a read-only SQL query against the loaded data tables",
    inputSchema: z.object({ sql: z.string().describe("SQL query to execute (SELECT only)") }),
    execute: ({ sql }): SqlExecuteResult => {
      const result = executeReadOnlyQuery(db, sql, "execute_sql", queryLog);
      if (!result.success) {
        logger.debug("SQL execution failed", { sql, error: result.error });
        return result;
      }
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
export function createSaveResultsTool(db: Database, queryLog: QueryExecution[]) {
  let savedResults: SavedResults | null = null;

  const saveResultsTool = tool({
    description:
      "Save query results as the analysis output artifact. Call this once with your final results.",
    inputSchema: z.object({
      sql: z.string().describe("SQL query whose results should be saved"),
      title: z.string().describe("Title for the results artifact"),
    }),
    execute: ({ sql, title }): SaveResultsResult => {
      const result = executeReadOnlyQuery(db, sql, "save_results", queryLog);
      if (!result.success) return result;
      savedResults = { rows: result.rows, title };
      return { success: true, rowCount: result.rows.length };
    },
  });

  return [saveResultsTool, () => savedResults] as const;
}

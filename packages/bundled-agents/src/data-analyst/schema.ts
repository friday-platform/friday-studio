import type { DatabaseSchema } from "@atlas/core/artifacts/server";

/**
 * Represents a table loaded into the analysis database.
 * Used for schema context building.
 */
export interface LoadedTableInfo {
  /** Full table name for SQL queries (e.g., "db0.sales" or "sales_data") */
  tableName: string;
  /** Schema information */
  schema: DatabaseSchema;
  /** Sample data for LLM context (first 3 rows) */
  sampleData: Record<string, unknown>[];
}

/**
 * Infers semantic column types from sample data.
 */
function inferColumnType(sampleData: Record<string, unknown>[], columnName: string): string {
  const values = sampleData.slice(0, 10).map((row) => row[columnName]);
  const nonNull = values.filter((v) => v != null);
  if (nonNull.length === 0) return "text";
  if (nonNull.every((v) => typeof v === "number")) return "numeric";
  if (nonNull.every((v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v))) return "date";
  return "text";
}

/**
 * Builds schema context string for LLM prompt injection.
 * Includes table names, column types, row counts, and sample data.
 *
 * Supports both attached databases (db0.tableName) and in-memory tables.
 *
 * @param tables - Array of loaded table information
 * @returns Formatted schema context for LLM consumption
 */
export function buildSchemaContext(tables: LoadedTableInfo[]): string {
  const sections: string[] = [];

  for (const table of tables) {
    const { tableName, schema, sampleData } = table;

    // Infer column types from sample data
    const columnTypes = schema.columns.map((col) => inferColumnType(sampleData, col.name));

    sections.push(`
## Table: ${tableName}
Columns (quote names with spaces in SQL):
${schema.columns.map((col, i) => `  - "${col.name}": ${columnTypes[i]}`).join("\n")}
Row count: ${schema.rowCount}

Sample data:
${JSON.stringify(sampleData, null, 2)}
`);
  }

  return sections.join("\n");
}

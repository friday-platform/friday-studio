/**
 * CSV Operations Schemas
 *
 * Zod schemas and type definitions for CSV operations
 */

import { z } from "zod";

export type CsvCell = string | number | boolean | null;

/**
 * Parsed CSV data structure
 */
export interface ParsedCsvFile {
  filePath: string;
  fileName: string;
  data: Record<string, CsvCell>[];
  rowCount: number;
  columns: string[];
}

/**
 * Filter operation schema
 */
export const FilterParamsSchema = z.object({
  fileName: z.string().describe("File name to filter (e.g., sales.csv)"),
  column: z.string().describe("Column name to filter on"),
  operator: z
    .enum(["eq", "ne", "gt", "lt", "gte", "lte", "contains", "startsWith", "endsWith"])
    .describe(
      "Comparison operator: eq (equals), ne (not equals), gt (greater than), lt (less than), gte (>=), lte (<=), contains, startsWith, endsWith",
    ),
  value: z.union([z.string(), z.number(), z.boolean()]).describe("Value to compare against"),
});

export type FilterParams = z.infer<typeof FilterParamsSchema>;

/**
 * Sort operation schema
 */
export const SortParamsSchema = z.object({
  fileName: z.string().describe("File name to sort (e.g., sales.csv)"),
  column: z.string().describe("Column name to sort by"),
  direction: z
    .enum(["asc", "desc"])
    .describe("Sort direction: asc (ascending) or desc (descending)"),
});

export type SortParams = z.infer<typeof SortParamsSchema>;

/**
 * Join operation schema
 */
export const JoinParamsSchema = z.object({
  fileName1: z.string().describe("First file name (e.g., sales.csv)"),
  fileName2: z.string().describe("Second file name (e.g., customers.csv)"),
  column1: z.string().describe("Column name from first file to join on"),
  column2: z.string().describe("Column name from second file to join on"),
  joinType: z
    .enum(["inner", "left", "right", "outer"])
    .describe("Join type: inner, left, right, or outer"),
});

export type JoinParams = z.infer<typeof JoinParamsSchema>;

/**
 * Aggregate operation schema
 */
export const AggregateParamsSchema = z.object({
  fileName: z.string().describe("File name to aggregate (e.g., sales.csv)"),
  groupByColumn: z.string().optional().describe("Column to group by (optional)"),
  aggregateColumn: z.string().describe("Column to perform aggregation on"),
  operation: z
    .enum(["sum", "avg", "min", "max", "count"])
    .describe("Aggregation operation: sum, avg, min, max, or count"),
});

export type AggregateParams = z.infer<typeof AggregateParamsSchema>;

/**
 * Get rows operation schema
 */
export const GetRowsParamsSchema = z.object({
  fileName: z.string().describe("File name (e.g., sales.csv)"),
  startRow: z.number().default(0).describe("Starting row index (0-based, default: 0)"),
  endRow: z.number().optional().describe("Ending row index (exclusive, default: startRow + 10)"),
});

export type GetRowsParams = z.infer<typeof GetRowsParamsSchema>;

/**
 * Limit rows operation schema
 */
export const LimitParamsSchema = z.object({
  fileName: z.string().describe("File name to limit (e.g., sales.csv)"),
  maxRows: z.number().min(1).describe("Maximum number of rows to keep"),
  random: z
    .boolean()
    .optional()
    .default(false)
    .describe("If true, randomly sample rows; if false, take first N rows"),
});

export type LimitParams = z.infer<typeof LimitParamsSchema>;

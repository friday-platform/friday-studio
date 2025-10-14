/**
 * CSV Data Operations
 *
 * Functions for manipulating CSV data that will be provided as tools to the LLM.
 * These functions operate on in-memory parsed CSV data.
 */

import { tool } from "ai";
import { z } from "zod";
import type {
  AggregateParams,
  CsvCell,
  FilterParams,
  GetRowsParams,
  JoinParams,
  ParsedCsvFile,
  SortParams,
} from "./schemas.ts";

/**
 * Tracks the result of CSV operations
 */
export interface OperationResult {
  dataByFile: Record<string, Record<string, CsvCell>[]>;
  operations: string[];
}

export type ParsedCsvFilesMap = Record<string, ParsedCsvFile>;

/**
 * Validate file index is within bounds
 */
function getRequiredFile(fileMap: ParsedCsvFilesMap, fileName: string): ParsedCsvFile {
  const file = fileMap[fileName];
  if (!file) {
    const available = Object.keys(fileMap);
    throw new Error(`Invalid file name '${fileName}'. Available files: ${available.join(", ")}`);
  }
  return file;
}

/**
 * Validate column exists in file
 */
function validateColumn(file: ParsedCsvFile, column: string): void {
  if (!file.columns.includes(column)) {
    throw new Error(
      `Column '${column}' does not exist in file ${file.fileName}. Available columns: ${file.columns.join(", ")}`,
    );
  }
}

/**
 * Compare two values based on operator
 */
function compareValues(
  rowValue: CsvCell | undefined,
  targetValue: string | number | boolean,
  operator: FilterParams["operator"],
): boolean {
  const a = rowValue ?? null;
  const rowStr = String(a ?? "");
  const targetStr = String(targetValue);

  switch (operator) {
    case "eq":
      return a === targetValue;
    case "ne":
      return a !== targetValue;
    case "gt":
      return Number(a) > Number(targetValue);
    case "lt":
      return Number(a) < Number(targetValue);
    case "gte":
      return Number(a) >= Number(targetValue);
    case "lte":
      return Number(a) <= Number(targetValue);
    case "contains":
      return rowStr.toLowerCase().includes(targetStr.toLowerCase());
    case "startsWith":
      return rowStr.toLowerCase().startsWith(targetStr.toLowerCase());
    case "endsWith":
      return rowStr.toLowerCase().endsWith(targetStr.toLowerCase());
    default:
      throw new Error(`Unknown operator: ${operator}`);
  }
}

/**
 * Filter rows based on column value and operator
 */
export function filterCsv(
  fileMap: ParsedCsvFilesMap,
  params: FilterParams,
  baseRows?: Record<string, CsvCell>[],
): Record<string, CsvCell>[] {
  const file = getRequiredFile(fileMap, params.fileName);
  validateColumn(file, params.column);
  const source = baseRows ?? file.data;
  return source.filter((row) => compareValues(row[params.column], params.value, params.operator));
}

/**
 * Sort rows by column in specified direction
 */
export function sortCsv(
  fileMap: ParsedCsvFilesMap,
  params: SortParams,
  baseRows?: Record<string, CsvCell>[],
): Record<string, CsvCell>[] {
  const file = getRequiredFile(fileMap, params.fileName);
  validateColumn(file, params.column);

  const sortedData = [...(baseRows ?? file.data)];

  sortedData.sort((a, b) => {
    const aVal = a[params.column];
    const bVal = b[params.column];

    // Handle null/undefined
    if (aVal == null && bVal == null) return 0;
    if (aVal == null) return params.direction === "asc" ? -1 : 1;
    if (bVal == null) return params.direction === "asc" ? 1 : -1;

    // Try numeric comparison first
    const aNum = Number(aVal);
    const bNum = Number(bVal);

    if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
      return params.direction === "asc" ? aNum - bNum : bNum - aNum;
    }

    // Fall back to string comparison
    const aStr = String(aVal);
    const bStr = String(bVal);

    if (params.direction === "asc") {
      return aStr.localeCompare(bStr);
    }
    return bStr.localeCompare(aStr);
  });

  return sortedData;
}

/**
 * Generate a unique column name that doesn't collide with existing columns
 */
function getUniqueColumnName(existingColumns: Set<string>, baseName: string): string {
  if (!existingColumns.has(baseName)) {
    return baseName;
  }

  let suffix = 1;
  let candidate = `${baseName}_${suffix}`;
  while (existingColumns.has(candidate)) {
    suffix++;
    candidate = `${baseName}_${suffix}`;
  }
  return candidate;
}

/**
 * Join two CSV files on specified columns
 */
export function joinCsv(
  fileMap: ParsedCsvFilesMap,
  params: JoinParams,
  baseRows1?: Record<string, CsvCell>[],
  baseRows2?: Record<string, CsvCell>[],
): Record<string, CsvCell>[] {
  const file1 = getRequiredFile(fileMap, params.fileName1);
  const file2 = getRequiredFile(fileMap, params.fileName2);

  validateColumn(file1, params.column1);
  validateColumn(file2, params.column2);

  const result: Record<string, CsvCell>[] = [];
  const matched2Indices = new Set<number>();

  // Inner and left join logic
  const rows1 = baseRows1 ?? file1.data;
  const rows2 = baseRows2 ?? file2.data;

  // Build set of existing columns from file1 (including any prior transformations)
  const existingColumns = new Set<string>(
    rows1.length > 0 && rows1[0] ? Object.keys(rows1[0]) : file1.columns,
  );

  // Pre-compute column mappings to ensure uniqueness
  const columnMappings = new Map<string, string>();
  for (const col of Object.keys(rows2[0] ?? {})) {
    const targetCol = existingColumns.has(col)
      ? getUniqueColumnName(existingColumns, `${file2.fileName}_${col}`)
      : col;
    columnMappings.set(col, targetCol);
    existingColumns.add(targetCol);
  }

  for (const row1 of rows1) {
    const key1 = row1[params.column1];
    let foundMatch = false;

    for (const [i, row2] of rows2.entries()) {
      const key2 = row2[params.column2];
      // Strict equality is fine because PapaParse already typed values; differences like "1" vs 1 should not match
      if (key1 === key2) {
        foundMatch = true;
        matched2Indices.add(i);

        // Merge rows using pre-computed column mappings
        const mergedRow: Record<string, CsvCell> = { ...row1 };

        for (const [col, val] of Object.entries(row2)) {
          const targetCol = columnMappings.get(col) ?? col;
          mergedRow[targetCol] = val;
        }

        result.push(mergedRow);
      }
    }

    // For left and outer joins, include unmatched rows from file1
    if (!foundMatch && (params.joinType === "left" || params.joinType === "outer")) {
      result.push({ ...row1 });
    }
  }

  // For right and outer joins, include unmatched rows from file2
  if (params.joinType === "right" || params.joinType === "outer") {
    for (const [i, row2] of rows2.entries()) {
      if (!matched2Indices.has(i)) {
        const mergedRow: Record<string, CsvCell> = {};

        for (const [col, val] of Object.entries(row2)) {
          const targetCol = columnMappings.get(col) ?? col;
          mergedRow[targetCol] = val;
        }

        result.push(mergedRow);
      }
    }
  }

  return result;
}

/**
 * Compute aggregate for a list of numeric values (non-count operations)
 */
function computeAggregate(
  values: number[],
  operation: Exclude<AggregateParams["operation"], "count">,
): number {
  switch (operation) {
    case "sum":
      return values.reduce((sum, val) => sum + val, 0);
    case "avg":
      return values.length > 0 ? values.reduce((sum, val) => sum + val, 0) / values.length : 0;
    case "min":
      return values.length > 0 ? Math.min(...values) : 0;
    case "max":
      return values.length > 0 ? Math.max(...values) : 0;
  }
}

/**
 * Aggregate data with optional grouping
 */
export function aggregateCsv(
  fileMap: ParsedCsvFilesMap,
  params: AggregateParams,
  baseRows?: Record<string, CsvCell>[],
): Record<string, CsvCell>[] {
  const file = getRequiredFile(fileMap, params.fileName);
  validateColumn(file, params.aggregateColumn);

  if (!params.groupByColumn) {
    // No grouping - aggregate entire dataset
    const source = baseRows ?? file.data;
    const values = source
      .map((row) => row[params.aggregateColumn])
      .filter((v) => v != null)
      .map(Number)
      .filter((n) => !Number.isNaN(n));

    let result: number;
    if (params.operation === "count") {
      result = source.length;
    } else if (
      params.operation === "sum" ||
      params.operation === "avg" ||
      params.operation === "min" ||
      params.operation === "max"
    ) {
      result = computeAggregate(values, params.operation);
    } else {
      throw new Error(`Unknown operation: ${params.operation}`);
    }

    return [{ [params.operation]: result }];
  } else {
    // Grouping branch
    validateColumn(file, params.groupByColumn);
    const groupByColumn = params.groupByColumn;

    const groups = new Map<string, number[]>();
    const groupRowCounts = new Map<string, number>();

    const source = baseRows ?? file.data;
    for (const row of source) {
      const groupKey = String(row[groupByColumn] ?? "");
      const value = row[params.aggregateColumn];

      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }

      // Track total row count per group for correct 'count' behavior
      groupRowCounts.set(groupKey, (groupRowCounts.get(groupKey) ?? 0) + 1);

      if (params.operation !== "count" && value != null) {
        const numValue = Number(value);
        if (!Number.isNaN(numValue)) {
          const arr = groups.get(groupKey);
          if (arr) arr.push(numValue);
        }
      }
    }

    const result: Record<string, CsvCell>[] = [];

    for (const [groupKey, values] of groups) {
      let aggregateResult: number;
      if (params.operation === "count") {
        aggregateResult = groupRowCounts.get(groupKey) ?? 0;
      } else if (
        params.operation === "sum" ||
        params.operation === "avg" ||
        params.operation === "min" ||
        params.operation === "max"
      ) {
        aggregateResult = computeAggregate(values, params.operation);
      } else {
        throw new Error(`Unknown operation: ${params.operation}`);
      }

      result.push({ [groupByColumn]: groupKey, [params.operation]: aggregateResult });
    }

    return result;
  }
}

/**
 * Get a slice of rows for inspection
 */
export function getRowsCsv(
  fileMap: ParsedCsvFilesMap,
  params: GetRowsParams,
): Record<string, unknown>[] {
  const file = getRequiredFile(fileMap, params.fileName);
  const start = params.startRow;
  const end = params.endRow ?? start + 10;

  if (start < 0) {
    throw new Error(`startRow must be >= 0, got ${start}`);
  }

  if (end < start) {
    throw new Error(`endRow (${end}) must be >= startRow (${start})`);
  }

  return file.data.slice(start, end);
}

/**
 * Build LLM tools that operate on parsed CSV files and update the operation result tracker
 */
export function getOperationTools(fileMap: ParsedCsvFilesMap, operationResult: OperationResult) {
  return {
    csv_filter: tool({
      description: "Filter CSV rows based on a column value and comparison operator",
      inputSchema: z.object({
        fileName: z.string(),
        column: z.string(),
        operator: z.enum([
          "eq",
          "ne",
          "gt",
          "lt",
          "gte",
          "lte",
          "contains",
          "startsWith",
          "endsWith",
        ]),
        value: z.union([z.string(), z.number(), z.boolean()]),
      }),
      execute: (params: FilterParams) => {
        const prior = operationResult.dataByFile[params.fileName];
        const result = filterCsv(fileMap, params, prior);
        operationResult.dataByFile[params.fileName] = result;
        operationResult.operations.push(
          `filter(file=${params.fileName}, column=${params.column}, op=${params.operator}, value=${params.value})`,
        );
        return {
          success: true,
          rowCount: result.length,
          message: `Filtered to ${result.length} rows where ${params.column} ${params.operator} ${params.value}`,
        };
      },
    }),
    csv_sort: tool({
      description: "Sort CSV rows by a column in ascending or descending order",
      inputSchema: z.object({
        fileName: z.string(),
        column: z.string(),
        direction: z.enum(["asc", "desc"]),
      }),
      execute: (params: SortParams) => {
        const prior = operationResult.dataByFile[params.fileName];
        const result = sortCsv(fileMap, params, prior);
        operationResult.dataByFile[params.fileName] = result;
        operationResult.operations.push(
          `sort(file=${params.fileName}, column=${params.column}, direction=${params.direction})`,
        );
        return {
          success: true,
          rowCount: result.length,
          message: `Sorted ${result.length} rows by ${params.column} ${params.direction}`,
        };
      },
    }),
    csv_join: tool({
      description:
        "Join two CSV files on specified columns using inner, left, right, or outer join",
      inputSchema: z.object({
        fileName1: z.string(),
        fileName2: z.string(),
        column1: z.string(),
        column2: z.string(),
        joinType: z.enum(["inner", "left", "right", "outer"]),
      }),
      execute: (params: JoinParams) => {
        const prior1 = operationResult.dataByFile[params.fileName1];
        const prior2 = operationResult.dataByFile[params.fileName2];
        const result = joinCsv(fileMap, params, prior1, prior2);
        operationResult.dataByFile[params.fileName1] = result;
        operationResult.operations.push(
          `join(file1=${params.fileName1}, file2=${params.fileName2}, on=${params.column1}=${params.column2}, type=${params.joinType})`,
        );
        return {
          success: true,
          rowCount: result.length,
          message: `${params.joinType} join produced ${result.length} rows`,
        };
      },
    }),
    csv_aggregate: tool({
      description: "Aggregate CSV data with optional grouping (sum, avg, min, max, count)",
      inputSchema: z.object({
        fileName: z.string(),
        groupByColumn: z.string().optional(),
        aggregateColumn: z.string(),
        operation: z.enum(["sum", "avg", "min", "max", "count"]),
      }),
      execute: (params: AggregateParams) => {
        const prior = operationResult.dataByFile[params.fileName];
        const result = aggregateCsv(fileMap, params, prior);
        operationResult.dataByFile[params.fileName] = result;
        const groupDesc = params.groupByColumn ? ` grouped by ${params.groupByColumn}` : "";
        operationResult.operations.push(
          `aggregate(file=${params.fileName}, op=${params.operation}, column=${params.aggregateColumn}${groupDesc})`,
        );
        return {
          success: true,
          rowCount: result.length,
          message: `Aggregation (${params.operation}) on ${params.aggregateColumn}${groupDesc} produced ${result.length} result rows`,
        };
      },
    }),
    csv_get_rows: tool({
      description: "Get a slice of rows from a CSV file for inspection",
      inputSchema: z.object({
        fileName: z.string(),
        startRow: z.number().default(0),
        endRow: z.number().optional(),
      }),
      execute: (params: GetRowsParams) => {
        const result = getRowsCsv(fileMap, params);
        const file = getRequiredFile(fileMap, params.fileName);
        operationResult.operations.push(
          `inspect(file=${params.fileName}, rows=${params.startRow}-${params.endRow ?? params.startRow + 10})`,
        );
        return {
          success: true,
          rowCount: result.length,
          columns: file.columns,
          sampleRow: result[0],
          message: `Retrieved ${result.length} rows from ${file.fileName} (rows ${params.startRow} to ${params.endRow ?? params.startRow + 10})`,
        };
      },
    }),
    csv_get_metadata: tool({
      description:
        "Get current CSV operation metadata. With optional fileName, returns per-file summary; otherwise returns global and per-file summaries.",
      inputSchema: z.object({ fileName: z.string().optional() }),
      execute: ({ fileName }: { fileName?: string }) => {
        if (fileName) {
          const file = getRequiredFile(fileMap, fileName);
          const currentData = operationResult.dataByFile[fileName] ?? file.data;
          const currentColumns =
            currentData.length > 0 && currentData[0] ? Object.keys(currentData[0]) : file.columns;
          return {
            success: true,
            fileName,
            originalRows: file.rowCount,
            originalColumns: file.columns,
            currentRowCount: currentData.length,
            currentColumns,
          };
        }

        const files = Object.values(fileMap).map((f) => {
          const currentData = operationResult.dataByFile[f.fileName] ?? f.data;
          const currentColumns =
            currentData.length > 0 && currentData[0] ? Object.keys(currentData[0]) : f.columns;
          return {
            fileName: f.fileName,
            originalRows: f.rowCount,
            originalColumns: f.columns,
            currentRowCount: currentData.length,
            currentColumns,
          };
        });

        return {
          success: true,
          totalFiles: files.length,
          availableFiles: Object.keys(fileMap),
          operationsCount: operationResult.operations.length,
          operations: operationResult.operations,
          files,
        };
      },
    }),
  } as const;
}

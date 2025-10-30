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
import {
  AggregateParamsSchema,
  FilterParamsSchema,
  GetRowsParamsSchema,
  JoinParamsSchema,
  SortParamsSchema,
} from "./schemas.ts";

/**
 * Tracks the result of CSV operations
 */
export interface OperationResult {
  dataByFile: Record<string, Record<string, CsvCell>[]>;
  columnsByFile: Record<string, string[]>;
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
 * Get current column names from data, with fallback to metadata
 *
 * For untransformed data (from original file), use metadata columns since rows with null
 * values might not have all properties. For transformed data (after joins/aggregates),
 * inspect actual row keys since column structure may have changed.
 *
 * @param data - Array of CSV rows
 * @param fallbackColumns - Column names from file metadata to use as fallback
 * @returns Current column names
 */
function getCurrentColumns(data: Record<string, CsvCell>[], fallbackColumns: string[]): string[] {
  if (data.length === 0 || !data[0]) return fallbackColumns;

  const keys = Object.keys(data[0]);
  return keys.length > 0 ? keys : fallbackColumns;
}

/**
 * Validate column exists in current data or original file
 *
 * For operations on untransformed data, validates against file.columns (metadata).
 * For operations on transformed data (after joins), validates against actual row keys.
 *
 * @param file - Parsed CSV file with original metadata
 * @param column - Column name to validate
 * @param currentData - Optional current transformed data (may have different columns than original)
 * @throws Error if column doesn't exist in current or original columns
 */
function validateColumn(
  file: ParsedCsvFile,
  column: string,
  currentData?: Record<string, CsvCell>[],
): void {
  // For transformed data (after joins), check actual row keys
  // For untransformed data, use file.columns metadata (handles null values correctly)
  const currentColumns = currentData ? getCurrentColumns(currentData, file.columns) : file.columns;

  if (!currentColumns.includes(column)) {
    throw new Error(
      `Column '${column}' does not exist in file ${file.fileName}. Available columns: ${currentColumns.join(", ")}`,
    );
  }
}

/**
 * Compare two values based on operator
 *
 * Null/undefined handling:
 * - eq/ne: null only equals null
 * - Numeric comparisons (gt, lt, gte, lte): null compares as NaN, always false
 * - String operations (contains, startsWith, endsWith): null is treated as empty string
 *
 * @param rowValue - Value from CSV row (may be null/undefined)
 * @param targetValue - Target value to compare against
 * @param operator - Comparison operator
 * @returns true if comparison passes, false otherwise
 */
function compareValues(
  rowValue: CsvCell | undefined,
  targetValue: string | number | boolean,
  operator: FilterParams["operator"],
): boolean {
  // Direct equality checks
  if (operator === "eq") return rowValue === targetValue;
  if (operator === "ne") return rowValue !== targetValue;

  // Numeric comparisons
  if (operator === "gt" || operator === "lt" || operator === "gte" || operator === "lte") {
    const a = Number(rowValue);
    const b = Number(targetValue);
    if (Number.isNaN(a) || Number.isNaN(b)) return false;

    if (operator === "gt") return a > b;
    if (operator === "lt") return a < b;
    if (operator === "gte") return a >= b;
    return a <= b; // lte
  }

  // String operations
  if (operator === "contains" || operator === "startsWith" || operator === "endsWith") {
    const rowStr = String(rowValue ?? "").toLowerCase();
    const targetStr = String(targetValue).toLowerCase();

    if (operator === "contains") return rowStr.includes(targetStr);
    if (operator === "startsWith") return rowStr.startsWith(targetStr);
    return rowStr.endsWith(targetStr); // endsWith
  }

  throw new Error(`Unknown operator: ${operator}`);
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
  const source = baseRows ?? file.data;
  validateColumn(file, params.column, baseRows);
  return source.filter((row) => compareValues(row[params.column], params.value, params.operator));
}

/**
 * Compare two CSV cell values for sorting
 *
 * @param aVal - First value to compare
 * @param bVal - Second value to compare
 * @param direction - Sort direction (asc or desc)
 * @returns Negative if a < b, positive if a > b, zero if equal
 */
function compareRowValues(
  aVal: CsvCell | undefined,
  bVal: CsvCell | undefined,
  direction: "asc" | "desc",
): number {
  // Handle null/undefined
  if (aVal == null && bVal == null) return 0;
  if (aVal == null) return direction === "asc" ? -1 : 1;
  if (bVal == null) return direction === "asc" ? 1 : -1;

  // Try numeric comparison first
  const aNum = Number(aVal);
  const bNum = Number(bVal);

  if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
    return direction === "asc" ? aNum - bNum : bNum - aNum;
  }

  // Fall back to string comparison
  const result = String(aVal).localeCompare(String(bVal));
  return direction === "asc" ? result : -result;
}

/**
 * Sort rows by column in specified direction
 *
 * @param fileMap - Map of file names to parsed CSV data
 * @param params - Sort parameters (file, column, direction)
 * @param baseRows - Optional transformed rows to sort
 * @returns Sorted array of rows
 */
export function sortCsv(
  fileMap: ParsedCsvFilesMap,
  params: SortParams,
  baseRows?: Record<string, CsvCell>[],
): Record<string, CsvCell>[] {
  const file = getRequiredFile(fileMap, params.fileName);
  const source = baseRows ?? file.data;
  validateColumn(file, params.column, baseRows);

  const sortedData = [...source];

  sortedData.sort((a, b) => compareRowValues(a[params.column], b[params.column], params.direction));

  return sortedData;
}

/**
 * Generate a unique column name that doesn't collide with existing columns
 *
 * @param existingColumns - Set of column names already in use
 * @param baseName - Base name to make unique
 * @returns Unique column name (baseName or baseName_N)
 */
function getUniqueColumnName(existingColumns: Set<string>, baseName: string): string {
  if (!existingColumns.has(baseName)) {
    return baseName;
  }

  let suffix = 1;
  while (existingColumns.has(`${baseName}_${suffix}`)) {
    suffix++;
  }
  return `${baseName}_${suffix}`;
}

/**
 * Merge a source row into a base row using column mappings
 *
 * @param baseRow - Base row to merge into (will be cloned)
 * @param sourceRow - Source row to merge from
 * @param columnMappings - Map from source column names to target column names
 * @returns New merged row
 */
function mergeRowWithMappings(
  baseRow: Record<string, CsvCell>,
  sourceRow: Record<string, CsvCell>,
  columnMappings: Map<string, string>,
): Record<string, CsvCell> {
  const merged = { ...baseRow };
  for (const [col, val] of Object.entries(sourceRow)) {
    const targetCol = columnMappings.get(col) ?? col;
    merged[targetCol] = val;
  }
  return merged;
}

/**
 * Join two CSV files on specified columns
 *
 * Performance: O(n + m) using hash map instead of nested loops
 *
 * @param fileMap - Map of file names to parsed CSV data
 * @param params - Join parameters (files, columns, join type)
 * @param baseRows1 - Optional transformed rows for first file
 * @param baseRows2 - Optional transformed rows for second file
 * @returns Joined rows with unique column names
 */
export function joinCsv(
  fileMap: ParsedCsvFilesMap,
  params: JoinParams,
  baseRows1?: Record<string, CsvCell>[],
  baseRows2?: Record<string, CsvCell>[],
): Record<string, CsvCell>[] {
  const file1 = getRequiredFile(fileMap, params.fileName1);
  const file2 = getRequiredFile(fileMap, params.fileName2);

  const rows1 = baseRows1 ?? file1.data;
  const rows2 = baseRows2 ?? file2.data;

  validateColumn(file1, params.column1, baseRows1);
  validateColumn(file2, params.column2, baseRows2);

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

  // Build hash map for rows2 by join key - O(m)
  // Each key may have multiple rows (handles duplicates correctly)
  const rows2ByKey = new Map<CsvCell | undefined, Record<string, CsvCell>[]>();
  for (const row2 of rows2) {
    const key2 = row2[params.column2];
    const existing = rows2ByKey.get(key2);
    if (existing) {
      existing.push(row2);
    } else {
      rows2ByKey.set(key2, [row2]);
    }
  }

  const result: Record<string, CsvCell>[] = [];
  const matchedKeys2 = new Set<CsvCell | undefined>();

  // Single pass through rows1 - O(n)
  for (const row1 of rows1) {
    const key1 = row1[params.column1];
    const matches = rows2ByKey.get(key1);

    if (matches) {
      matchedKeys2.add(key1);

      // Handle duplicate keys: create cartesian product
      for (const row2 of matches) {
        result.push(mergeRowWithMappings(row1, row2, columnMappings));
      }
    } else if (params.joinType === "left" || params.joinType === "outer") {
      // Left/outer join: include unmatched rows from file1
      result.push({ ...row1 });
    }
  }

  // For right and outer joins, include unmatched rows from file2
  if (params.joinType === "right" || params.joinType === "outer") {
    for (const [key2, rows] of rows2ByKey.entries()) {
      if (!matchedKeys2.has(key2)) {
        for (const row2 of rows) {
          result.push(mergeRowWithMappings({}, row2, columnMappings));
        }
      }
    }
  }

  return result;
}

/**
 * Compute aggregate for a list of numeric values (non-count operations)
 *
 * @param values - Array of numeric values to aggregate
 * @param operation - Aggregation operation (sum, avg, min, max)
 * @returns Computed aggregate value
 */
function computeAggregate(
  values: number[],
  operation: Exclude<AggregateParams["operation"], "count">,
): number {
  if (values.length === 0) return 0;

  switch (operation) {
    case "sum":
      return values.reduce((sum, val) => sum + val, 0);
    case "avg":
      return values.reduce((sum, val) => sum + val, 0) / values.length;
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
  }
}

/**
 * Aggregate entire dataset without grouping
 *
 * @param data - Array of CSV rows
 * @param column - Column to aggregate
 * @param operation - Aggregation operation
 * @returns Single row with aggregate result
 */
function aggregateWithoutGrouping(
  data: Record<string, CsvCell>[],
  column: string,
  operation: AggregateParams["operation"],
): Record<string, CsvCell> {
  if (operation === "count") {
    return { count: data.length };
  }

  const values = data
    .map((row) => row[column])
    .filter((v) => v != null)
    .map(Number)
    .filter((n) => !Number.isNaN(n));

  return { [operation]: computeAggregate(values, operation) };
}

/**
 * Aggregate dataset with grouping by column
 *
 * @param data - Array of CSV rows
 * @param groupByColumn - Column to group by
 * @param aggregateColumn - Column to aggregate
 * @param operation - Aggregation operation
 * @returns Array of rows with group key and aggregate result
 */
function aggregateWithGrouping(
  data: Record<string, CsvCell>[],
  groupByColumn: string,
  aggregateColumn: string,
  operation: AggregateParams["operation"],
): Record<string, CsvCell>[] {
  const groups = new Map<string, number[]>();
  const groupRowCounts = new Map<string, number>();

  // Build groups
  for (const row of data) {
    const groupKey = String(row[groupByColumn] ?? "");

    // Ensure group exists
    if (!groups.has(groupKey)) {
      groups.set(groupKey, []);
    }

    // Track row count for each group
    groupRowCounts.set(groupKey, (groupRowCounts.get(groupKey) ?? 0) + 1);

    // For non-count operations, collect numeric values
    if (operation !== "count") {
      const value = row[aggregateColumn];
      if (value != null) {
        const numValue = Number(value);
        if (!Number.isNaN(numValue)) {
          const groupValues = groups.get(groupKey);
          if (groupValues) {
            groupValues.push(numValue);
          }
        }
      }
    }
  }

  // Compute aggregates for each group
  const result: Record<string, CsvCell>[] = [];
  for (const groupKey of groups.keys()) {
    const values = groups.get(groupKey);
    if (!values) continue;

    const aggregateResult =
      operation === "count"
        ? (groupRowCounts.get(groupKey) ?? 0)
        : computeAggregate(values, operation);

    result.push({ [groupByColumn]: groupKey, [operation]: aggregateResult });
  }

  return result;
}

/**
 * Aggregate CSV data with optional grouping
 *
 * @param fileMap - Map of file names to parsed CSV data
 * @param params - Aggregation parameters
 * @param baseRows - Optional transformed rows
 * @returns Array of rows with aggregate results
 */
export function aggregateCsv(
  fileMap: ParsedCsvFilesMap,
  params: AggregateParams,
  baseRows?: Record<string, CsvCell>[],
): Record<string, CsvCell>[] {
  const file = getRequiredFile(fileMap, params.fileName);
  const data = baseRows ?? file.data;

  validateColumn(file, params.aggregateColumn, baseRows);

  if (!params.groupByColumn) {
    return [aggregateWithoutGrouping(data, params.aggregateColumn, params.operation)];
  }

  validateColumn(file, params.groupByColumn, baseRows);
  return aggregateWithGrouping(
    data,
    params.groupByColumn,
    params.aggregateColumn,
    params.operation,
  );
}

/**
 * Get a slice of rows for inspection
 *
 * @param fileMap - Map of file names to parsed CSV data
 * @param params - Parameters specifying which rows to retrieve
 * @returns Array of rows within the specified range
 * @throws Error if parameters are invalid
 */
export function getRowsCsv(
  fileMap: ParsedCsvFilesMap,
  params: GetRowsParams,
): Record<string, CsvCell>[] {
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
      inputSchema: FilterParamsSchema,
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
      inputSchema: SortParamsSchema,
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
      inputSchema: JoinParamsSchema,
      execute: (params: JoinParams) => {
        const prior1 = operationResult.dataByFile[params.fileName1];
        const prior2 = operationResult.dataByFile[params.fileName2];
        const result = joinCsv(fileMap, params, prior1, prior2);
        operationResult.dataByFile[params.fileName1] = result;

        // Update columns - inspect result data to get actual column structure
        const file1 = getRequiredFile(fileMap, params.fileName1);
        const resultColumns =
          result.length > 0 && result[0] ? Object.keys(result[0]) : file1.columns;
        operationResult.columnsByFile[params.fileName1] = resultColumns;

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
      inputSchema: AggregateParamsSchema,
      execute: (params: AggregateParams) => {
        const prior = operationResult.dataByFile[params.fileName];
        const result = aggregateCsv(fileMap, params, prior);
        operationResult.dataByFile[params.fileName] = result;

        // Update columns - aggregate changes column structure
        if (params.groupByColumn) {
          operationResult.columnsByFile[params.fileName] = [params.groupByColumn, params.operation];
        } else {
          operationResult.columnsByFile[params.fileName] = [params.operation];
        }

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
      inputSchema: GetRowsParamsSchema,
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
          const currentColumns = operationResult.columnsByFile[fileName] ?? file.columns;
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
          const currentColumns = operationResult.columnsByFile[f.fileName] ?? f.columns;
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
  };
}

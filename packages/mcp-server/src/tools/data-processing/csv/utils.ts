/**
 * CSV Parsing and Prompt Utilities
 */

import { anthropic } from "@atlas/core";
import { getTodaysDate } from "@atlas/utils";
import { generateText } from "ai";
import type { ToolContext } from "../../types.ts";
import type { OperationResult, ParsedCsvFilesMap } from "./operations.ts";
import { getOperationTools } from "./operations.ts";
import type { ParsedCsvFile } from "./schemas.ts";

/**
 * Build system prompt for CSV operations
 * Only includes metadata - actual data access happens through tools
 */
function buildSystemPrompt(parsedFiles: ParsedCsvFile[]): string {
  const fileDescriptions = parsedFiles
    .map((file) => {
      return `
File: ${file.fileName}
- Path: ${file.filePath}
- Rows: ${file.rowCount}
- Columns: ${file.columns.join(", ")}
`;
    })
    .join("\n");

  return `You orchestrate CSV data operations using tools.

Available files:
${fileDescriptions}

IMPORTANT - State Mutation Model:
- Operations modify files IN-PLACE. After filtering sales.csv, sales.csv contains ONLY filtered rows.
- Joins overwrite fileName1 with the join result. After csv_join(sales.csv, products.csv), sales.csv becomes the joined data. products.csv remains unchanged.
- Subsequent operations on a file operate on its CURRENT STATE (after transformations), not the original data.
- To chain operations: operate on the same file sequentially (e.g., filter sales.csv, then sort sales.csv).
- Column names may change after joins (colliding columns get prefixed).

Tools return metadata only (row counts, success messages) - not actual data. Use csv_get_rows to inspect data structure when needed.

For read-only requests ("read", "describe", "preview"), use csv_get_rows to sample data, then describe what you see. Don't transform.

For transformation requests, chain tools sequentially:
- csv_filter: Filter rows by column values
- csv_sort: Sort rows by column
- csv_join: Join two files
- csv_aggregate: Aggregate data (sum/avg/count/min/max)
- csv_limit: Limit row count (use for sampling or taking first N rows)

CRITICAL: Multi-step operations require MULTIPLE tool calls:
- "Filter then limit to N rows" → Call csv_filter, THEN call csv_limit(maxRows=N)
- "Filter then randomly sample N" → Call csv_filter, THEN call csv_limit(maxRows=N, random=true)
- "Sort then take top N" → Call csv_sort, THEN call csv_limit(maxRows=N)

csv_limit operates on the CURRENT state after previous operations. Always call csv_limit as a SEPARATE tool call after filtering/sorting.

Provide a concise summary:
1. What you did (1-2 sentences)
2. For each file: name, row count, column count, brief description of columns
3. For read-only: note that artifacts contain unchanged data

Current datetime (UTC): ${getTodaysDate()}`;
}

/**
 * Execute CSV operations using LLM with tool access
 * The LLM receives only metadata and uses tools to manipulate the actual data
 */
export async function executeCsvOperation(
  parsedFiles: ParsedCsvFile[],
  task: string,
  context: ToolContext,
): Promise<{ summary: string; result: OperationResult }> {
  const systemPrompt = buildSystemPrompt(parsedFiles);

  context.logger.info("Starting CSV operation", {
    fileCount: parsedFiles.length,
    totalRows: parsedFiles.reduce((sum, f) => sum + f.rowCount, 0),
    task,
  });

  // Track the final result of operations
  const operationResult: OperationResult = { dataByFile: {}, columnsByFile: {}, operations: [] };

  // Create tools that close over a file map and operationResult
  const fileMap: ParsedCsvFilesMap = Object.fromEntries(
    parsedFiles.map((f) => [f.fileName, f] as const),
  );

  // Initialize per-file data and column maps with original data
  for (const f of parsedFiles) {
    operationResult.dataByFile[f.fileName] = f.data;
    operationResult.columnsByFile[f.fileName] = f.columns;
  }

  const tools = getOperationTools(fileMap, operationResult);

  const result = await generateText({
    model: anthropic("claude-sonnet-4-5"),
    system: systemPrompt,
    prompt: task,
    tools,
    maxRetries: 3,
  });

  context.logger.info("CSV operation completed", {
    responseLength: result.text.length,
    operationsPerformed: operationResult.operations.length,
  });

  return { summary: result.text, result: operationResult };
}

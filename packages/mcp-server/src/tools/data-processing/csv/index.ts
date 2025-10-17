/**
 * CSV Operations Tool
 *
 * Performs operations on CSV files using LLM-guided data manipulation.
 * The tool parses CSV files and uses an LLM with specialized tools to execute
 * operations like filtering, sorting, joining, and aggregating data.
 *
 */

import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolContext } from "../../types.ts";
import { createErrorResponse, createSuccessResponse } from "../../utils.ts";
import { saveFilesAsArtifacts } from "./operations.ts";
import { executeCsvOperation, parseCsvFiles } from "./utils.ts";

/**
 * Input schema for CSV operations tool
 */
const CsvOperationInputSchema = z.object({
  csvFiles: z
    .array(z.string())
    .min(1)
    .describe("Array of absolute file paths to CSV files to process"),
  task: z
    .string()
    .min(1)
    .describe(
      "Description of the operation to perform (e.g., 'filter rows where sales > 1000', 'sort by date descending', 'join on customer_id')",
    ),
  workspaceId: z.string().min(1).describe("Workspace ID where the result artifact will be saved"),
});

/**
 * Register the CSV analysis tool with the MCP server
 */
export function registerCsvTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "csv",
    {
      description:
        "Use this tool to read CSV file data and perform operations such as filtering, sorting, joining, and aggregating. The result will be saved as an artifact.",
      inputSchema: {
        csvFiles: z.array(z.string()).describe("Absolute paths to CSV files"),
        task: z
          .string()
          .describe("Plain-language instruction for the operation (e.g. 'filter where x > 10')"),
        workspaceId: z.string().describe("Workspace ID to save the result as a table artifact"),
      },
    },
    async (params) => {
      try {
        // 1. Validate input
        const inputResult = CsvOperationInputSchema.safeParse(params);
        if (!inputResult.success) {
          context.logger.error("Invalid CSV tool parameters", { issues: inputResult.error.issues });
          return createErrorResponse(
            "Invalid parameters for CSV tool",
            inputResult.error.issues.map((i) => ({ path: i.path, message: i.message })),
          );
        }
        const input = inputResult.data;

        // 2. Parse CSV files
        context.logger.info("Parsing CSV files", { fileCount: input.csvFiles.length });
        const { parsed, failed } = await parseCsvFiles(input.csvFiles);

        if (parsed.length === 0) {
          return createErrorResponse("No CSV files were successfully parsed", {
            failedParses: failed,
          });
        }

        if (failed.length > 0) {
          context.logger.warn("Some CSV files failed to parse", {
            failedCount: failed.length,
            failed,
          });
        }

        // 3. Check for file name collisions
        const fileNames = parsed.map((f) => f.fileName);
        const uniqueNames = new Set(fileNames);
        if (fileNames.length !== uniqueNames.size) {
          const duplicates = fileNames.filter((name, index) => fileNames.indexOf(name) !== index);
          return createErrorResponse(
            `Duplicate file names detected: ${duplicates.join(", ")}. Files must have unique names.`,
          );
        }

        // 4. Execute operation with LLM
        const { summary, result } = await executeCsvOperation(parsed, input.task, context);

        // 5. Save artifacts
        try {
          const { artifactIds, summaryWithMapping } = await saveFilesAsArtifacts(
            parsed,
            result,
            input.workspaceId,
            context,
            summary,
          );

          return createSuccessResponse({ summary: summaryWithMapping, artifactIds });
        } catch (error) {
          const err = stringifyError(error);
          context.logger.error("Failed to save artifacts", { error: err });
          return createErrorResponse("Failed to save result artifact", err);
        }
      } catch (error) {
        context.logger.error("CSV operation failed", { error: error });
        return createErrorResponse("CSV operation failed", stringifyError(error));
      }
    },
  );

  context.logger.info("Registered csv tool");
}

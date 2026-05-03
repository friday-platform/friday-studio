/**
 * CSV Operations Tool
 *
 * Performs operations on CSV files using LLM-guided data manipulation.
 * The tool parses CSV files and uses an LLM with specialized tools to execute
 * operations like filtering, sorting, joining, and aggregating data.
 *
 */

import {
  ArtifactStorage,
  CsvParseResultSchema,
  parseCsvContent,
} from "@atlas/core/artifacts/server";
import { stringifyError } from "@atlas/utils";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Papa from "papaparse";
import { z } from "zod";
import type { ToolContext } from "../../types.ts";
import { createErrorResponse, createSuccessResponse } from "../../utils.ts";
import type { ParsedCsvFile } from "./schemas.ts";
import { executeCsvOperation } from "./utils.ts";

/**
 * Input schema for CSV operations tool
 */
const CsvOperationInputSchema = z.object({
  csvArtifactIds: z
    .array(z.string())
    .min(1)
    .describe("Array of file artifact IDs containing CSV data"),
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
        "Use this tool to read CSV files and perform operations such as filtering, sorting, joining, and aggregating. Provide artifact IDs for existing CSV artifacts. The result will be saved as a file artifact.",
      inputSchema: {
        csvArtifactIds: z
          .array(z.string())
          .min(1)
          .describe("File artifact IDs containing CSV data"),
        task: z
          .string()
          .describe("Plain-language instruction for the operation (e.g. 'filter where x > 10')"),
        workspaceId: z.string().describe("Workspace ID to save the result as a file artifact"),
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

        // 2. Load and parse CSV artifacts
        context.logger.info("Loading CSV artifacts", { count: input.csvArtifactIds.length });
        const parsed: ParsedCsvFile[] = [];

        for (const artifactId of input.csvArtifactIds) {
          // Get artifact metadata
          const artifactResult = await ArtifactStorage.get({ id: artifactId });
          if (!artifactResult.ok) {
            return createErrorResponse(`Artifact ${artifactId} not found`);
          }

          const artifact = artifactResult.data;
          if (!artifact) {
            return createErrorResponse(`Artifact ${artifactId} not found`);
          }

          if (artifact.data.type !== "file") {
            return createErrorResponse(`Artifact ${artifactId} is not a file artifact`);
          }

          // Read file contents via storage adapter
          const contentsResult = await ArtifactStorage.readFileContents({ id: artifactId });
          if (!contentsResult.ok) {
            return createErrorResponse(
              `Failed to read artifact ${artifactId}: ${contentsResult.error}`,
            );
          }

          // Parse CSV content
          const csvResult = parseCsvContent(contentsResult.data, artifactId);
          const validatedResult = CsvParseResultSchema.parse(csvResult);

          // Use artifact title or ID as filename
          const fileName = artifact.title || artifactId.slice(0, 8);

          parsed.push({
            filePath: artifactId,
            fileName,
            data: validatedResult.data,
            rowCount: validatedResult.rowCount,
            columns: validatedResult.columns,
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

        // 5. Save results as file artifacts
        const resultArtifactIds: string[] = [];
        const nameToIdPairs: string[] = [];

        for (const f of parsed) {
          const rows = result.dataByFile[f.fileName] ?? f.data;
          const columns = result.columnsByFile[f.fileName] ?? f.columns;

          const csvContent = Papa.unparse({ fields: columns, data: rows });
          const outputFileName = `${f.fileName.replace(/\.csv$/i, "")}-transformed.csv`;

          const createResult = await ArtifactStorage.create({
            data: {
              type: "file",
              content: csvContent,
              mimeType: "text/csv",
              originalName: outputFileName,
            },
            title: `${f.fileName} (transformed)`,
            summary: `Transformed CSV: ${f.fileName}`,
            workspaceId: input.workspaceId,
          });

          if (!createResult.ok) {
            const err = stringifyError(createResult.error);
            context.logger.error("Failed to save file artifact", { error: err, file: f.fileName });
            return createErrorResponse(`Failed to save artifact for ${f.fileName}: ${err}`);
          }

          const id = createResult.data.id;
          resultArtifactIds.push(id);
          nameToIdPairs.push(`- ${f.fileName} -> ${id}`);
        }

        const mappingText = nameToIdPairs.join("\n");
        const summaryWithMapping = `${summary}\n\ncsv_name->artifactId:\n${mappingText}`;

        return createSuccessResponse({
          summary: summaryWithMapping,
          artifactIds: resultArtifactIds,
        });
      } catch (error) {
        context.logger.error("CSV operation failed", { error: error });
        return createErrorResponse("CSV operation failed", stringifyError(error));
      }
    },
  );

  context.logger.info("Registered csv tool");
}

/**
 * CSV Operations Tool
 *
 * Performs operations on CSV files using LLM-guided data manipulation.
 * The tool parses CSV files and uses an LLM with specialized tools to execute
 * operations like filtering, sorting, joining, and aggregating data.
 *
 */

import { mkdir } from "node:fs/promises";
import type { Artifact } from "@atlas/core/artifacts";
import { FileDataSchema } from "@atlas/core/artifacts";
import { ArtifactStorage, CsvParseResultSchema, parseCsv } from "@atlas/core/artifacts/server";
import { stringifyError } from "@atlas/utils";
import { getWorkspaceFilesDir } from "@atlas/utils/paths.server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { basename } from "@std/path";
import Papa from "papaparse";
import { z } from "zod";
import type { ToolContext } from "../../types.ts";
import { createErrorResponse, createSuccessResponse } from "../../utils.ts";
import type { ParsedCsvFile } from "./schemas.ts";
import { executeCsvOperation } from "./utils.ts";

/**
 * Input schema for CSV operations tool
 */
const CsvOperationInputSchema = z
  .object({
    csvArtifactIds: z
      .array(z.string())
      .optional()
      .describe("Array of file artifact IDs containing CSV data"),
    filePaths: z.array(z.string()).optional().describe("Array of file paths to CSV files on disk"),
    task: z
      .string()
      .min(1)
      .describe(
        "Description of the operation to perform (e.g., 'filter rows where sales > 1000', 'sort by date descending', 'join on customer_id')",
      ),
    workspaceId: z.string().min(1).describe("Workspace ID where the result artifact will be saved"),
  })
  .refine(
    (data) => {
      const hasArtifactIds = data.csvArtifactIds && data.csvArtifactIds.length > 0;
      const hasFilePaths = data.filePaths && data.filePaths.length > 0;
      return hasArtifactIds !== hasFilePaths; // XOR - exactly one must be provided
    },
    { message: "Must provide either csvArtifactIds or filePaths (not both)" },
  );

/**
 * Register the CSV analysis tool with the MCP server
 */
export function registerCsvTool(server: McpServer, context: ToolContext): void {
  server.registerTool(
    "csv",
    {
      description:
        "Use this tool to read CSV files and perform operations such as filtering, sorting, joining, and aggregating. Provide either csvArtifactIds (for existing artifacts) or filePaths (for files on disk). The result will be saved as a file artifact.",
      inputSchema: {
        csvArtifactIds: z
          .array(z.string())
          .optional()
          .describe("File artifact IDs containing CSV data"),
        filePaths: z.array(z.string()).optional().describe("File paths to CSV files on disk"),
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

        // 2. Create artifacts from file paths if provided
        let artifactIds: string[] = [];
        if (input.filePaths && input.filePaths.length > 0) {
          context.logger.info("Creating artifacts from file paths", {
            count: input.filePaths.length,
          });
          for (const filePath of input.filePaths) {
            const fileName = basename(filePath);

            const createResult = await ArtifactStorage.create({
              data: { type: "file", version: 1, data: { path: filePath } },
              title: fileName,
              summary: `CSV file: ${fileName}`,
              workspaceId: input.workspaceId,
            });

            if (!createResult.ok) {
              const err = stringifyError(createResult.error);
              context.logger.error("Failed to create artifact from file path", {
                error: err,
                filePath,
              });
              return createErrorResponse(`Failed to create artifact from ${filePath}: ${err}`);
            }

            artifactIds.push(createResult.data.id);
          }
        } else if (input.csvArtifactIds) {
          artifactIds = input.csvArtifactIds;
        }

        // 3. Load artifact metadata
        context.logger.info("Loading CSV artifacts", { count: artifactIds.length });
        const loadedArtifacts: Artifact[] = [];
        for (const artifactId of artifactIds) {
          const result = await ArtifactStorage.get({ id: artifactId });
          if (!result.ok) {
            return createErrorResponse(`Artifact ${artifactId} not found`);
          }

          const artifact = result.data;
          if (!artifact) {
            return createErrorResponse(`Artifact ${artifactId} not found`);
          }

          // Validate it's a file artifact
          if (artifact.data.type !== "file") {
            return createErrorResponse(`Artifact ${artifactId} is not a file artifact`);
          }

          // Parse and validate file data
          const fileDataResult = FileDataSchema.safeParse(artifact.data.data);
          if (!fileDataResult.success) {
            return createErrorResponse(`Artifact ${artifactId} has invalid file data`);
          }

          loadedArtifacts.push(artifact);
        }

        // 4. Parse CSV files
        context.logger.info("Parsing CSV files from artifacts");
        const parsed: ParsedCsvFile[] = [];
        for (const artifact of loadedArtifacts) {
          // We validated this is a file artifact with valid FileData above
          if (artifact.data.type !== "file") continue;

          const fileDataResult = FileDataSchema.parse(artifact.data.data);
          const csvResult = await parseCsv(fileDataResult.path);

          // Validate the parse result matches expected schema
          const validatedResult = CsvParseResultSchema.parse(csvResult);

          const fileName = basename(fileDataResult.path);

          parsed.push({
            filePath: fileDataResult.path,
            fileName,
            data: validatedResult.data,
            rowCount: validatedResult.rowCount,
            columns: validatedResult.columns,
          });
        }

        // 5. Check for file name collisions
        const fileNames = parsed.map((f) => f.fileName);
        const uniqueNames = new Set(fileNames);
        if (fileNames.length !== uniqueNames.size) {
          const duplicates = fileNames.filter((name, index) => fileNames.indexOf(name) !== index);
          return createErrorResponse(
            `Duplicate file names detected: ${duplicates.join(", ")}. Files must have unique names.`,
          );
        }

        // 6. Execute operation with LLM
        const { summary, result } = await executeCsvOperation(parsed, input.task, context);

        // 7. Save results as file artifacts
        const resultArtifactIds: string[] = [];
        const nameToIdPairs: string[] = [];

        for (const f of parsed) {
          const rows = result.dataByFile[f.fileName] ?? f.data;
          const columns = result.columnsByFile[f.fileName] ?? f.columns;

          // Convert to CSV content
          const csvContent = Papa.unparse({ fields: columns, data: rows });

          // Write to workspace files directory
          const workspaceFilesDir = getWorkspaceFilesDir(input.workspaceId);
          await mkdir(workspaceFilesDir, { recursive: true });

          const outputFileName = `${crypto.randomUUID()}.csv`;
          const outputPath = `${workspaceFilesDir}/${outputFileName}`;
          await Deno.writeTextFile(outputPath, csvContent);

          // Set restrictive permissions (owner read/write only)
          await Deno.chmod(outputPath, 0o600);

          // Create artifact pointing to the file
          const createResult = await ArtifactStorage.create({
            data: { type: "file", version: 1, data: { path: outputPath } },
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

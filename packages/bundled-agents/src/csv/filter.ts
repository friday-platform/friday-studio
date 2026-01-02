import { mkdir, stat, writeFile } from "node:fs/promises";
import { type ArtifactRef, createAgent, repairToolCall } from "@atlas/agent-sdk";
import { ArtifactStorage, parseCsv } from "@atlas/core/artifacts/server";
import { registry } from "@atlas/llm";
import { isErrnoException } from "@atlas/utils";
import { getWorkspaceFilesDir } from "@atlas/utils/paths.server";
import { Database } from "@db/sqlite";
import { basename, join } from "@std/path";
import type { ModelMessage } from "ai";
import { generateText, tool } from "ai";
import { z } from "zod";

/**
 * CSV Filter Sampler Agent
 *
 * Reads CSV files, filters based on natural language criteria, and returns
 * N random samples in a structured JSON artifact for downstream agent consumption.
 * Designed for CSV filtering and sampling workflows.
 */

type CsvFilterSamplerResult = { summary: string; artifactRef: ArtifactRef };

export const csvFilterSamplerAgent = createAgent<string, CsvFilterSamplerResult>({
  id: "csv-filter-sampler",
  displayName: "CSV Filter Sampler",
  version: "1.0.0",
  description:
    "Read and filter CSV files using natural language queries, randomly sample N records, return structured JSON artifact",
  expertise: {
    domains: ["csv", "filtering", "sampling"],
    examples: [
      "Read /data/contacts.csv and filter for United States contacts with decision-making titles, sample 3",
      "Filter leads.csv for qualified prospects in the enterprise segment, select 5 random samples",
      "Show me 3 random samples from prospects.csv where industry is SaaS and company size > 100",
    ],
  },

  handler: async (
    prompt,
    { session, logger, abortSignal, stream },
  ): Promise<CsvFilterSamplerResult> => {
    try {
      logger.info("Parsing prompt to extract CSV path and filter criteria");

      let csvPath = "";
      let filterCriteria = "";
      let sampleCount = 3;

      const PathExtractionSchema = z.object({
        csvPath: z.string().describe("Absolute path to the CSV file"),
        filterCriteria: z
          .string()
          .describe("Natural language filter criteria extracted from the prompt"),
        sampleCount: z
          .number()
          .int()
          .positive()
          .default(3)
          .describe("Number of random samples to select (extract from prompt, default 3)"),
      });

      const validatePathTool = tool({
        description: "Validate extracted CSV path exists on filesystem",
        inputSchema: PathExtractionSchema,
        execute: async (params: z.infer<typeof PathExtractionSchema>) => {
          try {
            const stats = await stat(params.csvPath);
            if (!stats.isFile()) {
              throw new Error(`Path exists but is not a file: ${params.csvPath}`);
            }

            csvPath = params.csvPath;
            filterCriteria = params.filterCriteria;
            sampleCount = params.sampleCount;

            logger.info("CSV path validated", { csvPath, filterCriteria, sampleCount });

            return { success: true, message: `Valid CSV file path: ${params.csvPath}` };
          } catch (error) {
            if (isErrnoException(error) && error.code === "ENOENT") {
              throw new Error(`CSV file not found: ${params.csvPath}`);
            }
            throw error;
          }
        },
      });

      const parseMessages: Array<ModelMessage> = [
        {
          role: "system",
          content: `Extract the CSV file path, filter criteria, and sample count from the user's prompt.

IMPORTANT:
- The CSV path MUST be an absolute path to an existing file
- The filter criteria should be the natural language description of what to filter for
- The sample count is how many random records to select (look for numbers like "3 contacts", "5 samples", etc.). Default to 3 if not specified.

Call validatePath tool with the extracted information to verify the path exists.`,
        },
        { role: "user", content: prompt },
      ];

      const parseResult = await generateText({
        model: registry.languageModel("groq:openai/gpt-oss-120b"),
        abortSignal,
        messages: parseMessages,
        tools: { validatePath: validatePathTool },
        experimental_repairToolCall: repairToolCall,
      });

      // Log token usage including cache statistics
      logger.debug("AI SDK generateText completed", {
        agent: "csv-filter-sampler",
        step: "parse-prompt",
        usage: parseResult.usage,
      });

      if (!csvPath) {
        throw new Error("Failed to extract valid CSV path from prompt");
      }

      logger.info("Parsing CSV file", { csvPath });
      const parsedCsv = await parseCsv(csvPath);

      logger.info("CSV parsed successfully", {
        fileName: basename(csvPath),
        totalRecords: parsedCsv.rowCount,
        columns: parsedCsv.columns,
      });

      logger.info("Loading CSV into SQLite database");
      const db = new Database(":memory:");

      const columnDefs = parsedCsv.columns.map((col) => `"${col}" TEXT`).join(", ");
      db.exec(`CREATE TABLE data (${columnDefs})`);

      const placeholders = parsedCsv.columns.map(() => "?").join(", ");
      const insertStmt = db.prepare(`INSERT INTO data VALUES (${placeholders})`);

      db.exec("BEGIN TRANSACTION");
      for (const row of parsedCsv.data) {
        const values = parsedCsv.columns.map((col) => row[col]);
        insertStmt.run(...values);
      }
      db.exec("COMMIT");
      insertStmt.finalize();

      logger.info("CSV loaded into SQLite", { rowCount: parsedCsv.rowCount });

      logger.info("Generating SQL WHERE clause with LLM");
      let whereClause = "";

      // Get sample data for LLM
      const sampleRows = db.prepare("SELECT * FROM data LIMIT 3").all();

      // Build SQL generation tool
      const SqlWhereSchema = z.object({
        whereClause: z
          .string()
          .describe(
            "SQL WHERE clause (without the WHERE keyword). Use 1=0 for impossible filters. Empty string means no filtering.",
          ),
      });

      const buildSqlWhereTool = tool({
        description: "Build SQL WHERE clause for filtering CSV data",
        inputSchema: SqlWhereSchema,
        execute: (params: z.infer<typeof SqlWhereSchema>) => {
          // Validate SQL by executing COUNT query
          // Note: Direct SQL interpolation from LLM output. Risk mitigated by:
          // - In-memory temporary database (no persistent data at risk)
          // - Validation via execution catches syntax errors
          // - No data exfiltration possible (isolated process)
          try {
            const testQuery = params.whereClause
              ? `SELECT COUNT(*) as count FROM data WHERE ${params.whereClause}`
              : "SELECT COUNT(*) as count FROM data";
            const result = db.prepare(testQuery).get<{ count: number }>();

            if (!result) {
              throw new Error("Query returned no results");
            }

            whereClause = params.whereClause;
            logger.info("SQL WHERE clause validated", { whereClause, matchCount: result.count });

            return {
              success: true,
              matchCount: result.count,
              message: `Valid SQL WHERE clause. Matches ${result.count} rows.`,
            };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            throw new Error(`Invalid SQL WHERE clause: ${errorMessage}`);
          }
        },
      });

      const sqlMessages: Array<ModelMessage> = [
        {
          role: "system",
          content: `You are generating a SQL WHERE clause to filter CSV data loaded into SQLite.

Table: data
Columns: ${parsedCsv.columns.map((c) => `"${c}"`).join(", ")}

Sample rows (first 3):
${JSON.stringify(sampleRows, null, 2)}

Total rows in table: ${parsedCsv.rowCount}

IMPORTANT SQL RULES:
- Column names with spaces or special characters MUST be quoted with double quotes: "column name"
- String literals use single quotes: 'value'
- Use LIKE for pattern matching (case-insensitive by default in SQLite): "title" LIKE '%CEO%'
- Use IN for multiple values: "Seniority" IN ('C suite', 'Vp', 'Director')
- Use OR and AND for complex conditions: ("title" LIKE '%CEO%' OR "Seniority" = 'C suite')
- Use = for exact match, != for not equals
- Numeric comparisons: >, <, >=, <=
- If impossible criteria (e.g., "Antarctica contacts" when only USA/Canada exist), use: 1=0
- If no filtering needed (e.g., "show all"), return empty string

EXAMPLES:
User: "United States contacts"
WHERE: "Country" = 'USA'

User: "contacts with CEO or Director title"
WHERE: "title" LIKE '%CEO%' OR "title" LIKE '%Director%'

User: "USA contacts with C-suite or VP seniority"
WHERE: "Country" = 'USA' AND "Seniority" IN ('C suite', 'Vp')

User: "contacts with decision-making titles (CEO, CFO, CTO, Director, VP, President) or Senior/C-suite seniority"
WHERE: ("title" LIKE '%CEO%' OR "title" LIKE '%CFO%' OR "title" LIKE '%CTO%' OR "title" LIKE '%Director%' OR "title" LIKE '%VP%' OR "title" LIKE '%President%' OR "Seniority" IN ('C suite', 'Senior'))

User: "Antarctica contacts" (impossible - no Antarctica in data)
WHERE: 1=0

Call buildSqlWhere tool with your WHERE clause (WITHOUT the 'WHERE' keyword).`,
        },
        { role: "user", content: filterCriteria },
      ];

      const sqlResult = await generateText({
        model: registry.languageModel("groq:openai/gpt-oss-120b"),
        abortSignal,
        messages: sqlMessages,
        tools: { buildSqlWhere: buildSqlWhereTool },
        experimental_repairToolCall: repairToolCall,
      });

      // Log token usage including cache statistics
      logger.debug("AI SDK generateText completed", {
        agent: "csv-filter-sampler",
        step: "build-sql-where",
        usage: sqlResult.usage,
      });

      logger.info("Executing SQL query", { sampleCount });
      const query = whereClause
        ? `SELECT *, COUNT(*) OVER() as total_count FROM data WHERE ${whereClause} ORDER BY RANDOM() LIMIT ${sampleCount}`
        : `SELECT *, COUNT(*) OVER() as total_count FROM data ORDER BY RANDOM() LIMIT ${sampleCount}`;

      const rawSamples = db.prepare(query).all<Record<string, unknown>>();

      // Extract filtered count from first row (same across all rows due to window function)
      const filteredCount = rawSamples.length > 0 ? Number(rawSamples[0]?.total_count) : 0;

      // Remove total_count from samples (not part of CSV data)
      const samples = rawSamples.map(({ total_count: _total_count, ...sample }) => sample);

      db.close();

      logger.info("SQL query executed", { filteredCount, actualSampleCount: samples.length });

      logger.info("Creating JSON artifact");
      const timestamp = new Date().toISOString();

      const artifactData = {
        metadata: {
          totalRecords: parsedCsv.rowCount,
          filteredCount,
          sampleCount: samples.length,
          unprocessedCount: filteredCount - samples.length,
          csvPath,
          filterCriteria,
          sqlWhereClause: whereClause || "(no filter)",
          timestamp,
        },
        samples,
      };

      // Write JSON to file
      const workspaceFilesDir = getWorkspaceFilesDir(session.workspaceId);
      await mkdir(workspaceFilesDir, { recursive: true });

      const jsonFileName = `csv-filter-${timestamp.replace(/[:.]/g, "-")}.json`;
      const jsonFilePath = join(workspaceFilesDir, jsonFileName);

      await writeFile(jsonFilePath, JSON.stringify(artifactData, null, 2), "utf-8");

      // Create file artifact
      const createResult = await ArtifactStorage.create({
        workspaceId: session.workspaceId,
        data: { type: "file", version: 1, data: { path: jsonFilePath } },
        title: `CSV Filter: ${basename(csvPath)}`,
        summary: `CSV filter results: ${samples.length} sample(s) from ${filteredCount} filtered record(s)`,
      });

      if (!createResult.ok) {
        throw new Error(`Failed to create artifact: ${createResult.error}`);
      }

      logger.info("Artifact created", { artifactId: createResult.data.id });

      const summary = `Filtered ${parsedCsv.rowCount} total records to ${filteredCount} matching records, sampled ${samples.length} random record(s). ${filteredCount - samples.length} record(s) left unprocessed.`;

      stream?.emit({
        type: "data-outline-update",
        data: {
          id: "csv-filter-sampler",
          content: summary,
          title: "CSV Filter",
          timestamp: Date.now(),
          artifactId: createResult.data.id,
          artifactLabel: "View Filter",
        },
      });

      return {
        summary,
        artifactRef: { id: createResult.data.id, type: "file", summary: createResult.data.summary },
      };
    } catch (error) {
      logger.error("CSV filter agent failed", { error });
      throw error;
    }
  },
});

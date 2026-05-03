import { createAgent, err, ok, repairToolCall } from "@atlas/agent-sdk";
import { streamTextWithEvents } from "@atlas/agent-sdk/vercel-helpers";
import { ArtifactStorage, parseCsvContent } from "@atlas/core/artifacts/server";
import { registry, traceModel } from "@atlas/llm";
import { stringifyError } from "@atlas/utils";
import { Database } from "@db/sqlite";
import type { ModelMessage } from "ai";
import { tool } from "ai";
import { z } from "zod";

/**
 * CSV Filter Sampler Agent
 *
 * Reads CSV files, filters based on natural language criteria, and returns
 * N random samples in a structured JSON artifact for downstream agent consumption.
 * Designed for CSV filtering and sampling workflows.
 */

export const CsvFilterSamplerOutputSchema = z.object({
  response: z.string().describe("Human-readable summary of the filtering operation"),
});

type CsvFilterSamplerResult = z.infer<typeof CsvFilterSamplerOutputSchema>;

export const csvFilterSamplerAgent = createAgent<string, CsvFilterSamplerResult>({
  id: "csv-filter-sampler",
  displayName: "CSV Filter Sampler",
  version: "1.0.0",
  summary:
    "Filter rows in CSV artifacts using natural language criteria and return random samples as JSON.",
  description:
    "Reads CSV artifact files, filters rows using natural language criteria via SQL, and returns N random samples as a structured JSON artifact. USE FOR: filtering uploaded CSV data and sampling records for downstream processing.",
  constraints:
    "Operates on CSV file artifacts only. Cannot write or modify the source CSV. Cannot query databases or workspace resource tables. For full SQL analytics on database artifacts, use data-analyst.",
  outputSchema: CsvFilterSamplerOutputSchema,
  expertise: {
    examples: [
      "Read artifact 17602586-f090-11f0-b0d1-33569426ac3c and filter for United States contacts with decision-making titles, sample 3",
      "Filter artifact abc123 for qualified prospects in the enterprise segment, select 5 random samples",
      "Show me 3 random samples from artifact xyz789 where industry is SaaS and company size > 100",
    ],
  },

  handler: async (prompt, { session, logger, abortSignal, stream }) => {
    try {
      logger.info("Parsing prompt to extract artifact ID and filter criteria");

      let artifactId = "";
      let filterCriteria = "";
      let sampleCount = 3;
      let csvContent: string | null = null;

      const ArtifactExtractionSchema = z.object({
        artifactId: z.string().describe("The artifact ID (UUID) containing the CSV data"),
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

      const validateArtifactTool = tool({
        description: "Validate that the artifact exists and contains CSV data.",
        inputSchema: ArtifactExtractionSchema,
        execute: async (params: z.infer<typeof ArtifactExtractionSchema>) => {
          logger.info("Validating artifact", { artifactId: params.artifactId });

          const contentsResult = await ArtifactStorage.readFileContents({ id: params.artifactId });
          if (!contentsResult.ok) {
            throw new Error(
              `Failed to read artifact ${params.artifactId}: ${contentsResult.error}`,
            );
          }

          csvContent = contentsResult.data;
          artifactId = params.artifactId;
          filterCriteria = params.filterCriteria;
          sampleCount = params.sampleCount;

          logger.info("Artifact validated", { artifactId, filterCriteria, sampleCount });
          return { success: true, message: `Valid artifact: ${params.artifactId}` };
        },
      });

      const parseMessages: Array<ModelMessage> = [
        {
          role: "system",
          content: `Extract the artifact ID, filter criteria, and sample count from the user's prompt.

IMPORTANT:
- The artifact ID is a UUID identifying a CSV file stored in the system (e.g., 17602586-f090-11f0-b0d1-33569426ac3c)
- The filter criteria should be the natural language description of what to filter for
- The sample count is how many random records to select (look for numbers like "3 contacts", "5 samples", etc.). Default to 3 if not specified.

Call validateArtifact tool with the extracted information to verify the artifact exists.`,
        },
        { role: "user", content: prompt },
      ];

      const parseResult = await streamTextWithEvents({
        params: {
          model: traceModel(registry.languageModel("groq:openai/gpt-oss-120b")),
          abortSignal,
          messages: parseMessages,
          tools: { validateArtifact: validateArtifactTool },
          experimental_repairToolCall: repairToolCall,
        },
        stream,
      });

      logger.debug("Parse prompt completed", { usage: parseResult.usage });

      if (parseResult.finishReason === "error") {
        logger.error("csv-filter-sampler LLM returned error", {
          phase: "parse-prompt",
          finishReason: parseResult.finishReason,
        });
        return err("Failed to parse filter prompt");
      }

      if (!artifactId || !csvContent) {
        return err("Failed to extract valid artifact ID from prompt");
      }

      logger.info("Parsing CSV", { artifactId });

      const parsedCsv = parseCsvContent(csvContent, artifactId);

      logger.info("CSV parsed successfully", {
        artifactId,
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
          // Direct SQL interpolation from LLM. Safe: in-memory DB, isolated process, no exfil path.
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

      const sqlResult = await streamTextWithEvents({
        params: {
          model: traceModel(registry.languageModel("groq:openai/gpt-oss-120b")),
          abortSignal,
          messages: sqlMessages,
          tools: { buildSqlWhere: buildSqlWhereTool },
          experimental_repairToolCall: repairToolCall,
        },
        stream,
      });

      logger.debug("SQL generation completed", { usage: sqlResult.usage });

      if (sqlResult.finishReason === "error") {
        logger.error("csv-filter-sampler LLM returned error", {
          phase: "sql-generation",
          finishReason: sqlResult.finishReason,
        });
        return err("Failed to generate SQL filter");
      }

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
          sourceArtifactId: artifactId,
          filterCriteria,
          sqlWhereClause: whereClause || "(no filter)",
          timestamp,
        },
        samples,
      };

      const jsonFileName = `csv-filter-${timestamp.replace(/[:.]/g, "-")}.json`;
      const jsonContent = JSON.stringify(artifactData, null, 2);

      const artifactResult = await ArtifactStorage.create({
        workspaceId: session.workspaceId,
        data: {
          type: "file",
          content: jsonContent,
          mimeType: "application/json",
          originalName: jsonFileName,
        },
        title: `CSV Filter: ${artifactId.slice(0, 8)}`,
        summary: `CSV filter results: ${samples.length} sample(s) from ${filteredCount} filtered record(s)`,
      });

      if (!artifactResult.ok) {
        return err(`Failed to create artifact: ${artifactResult.error}`);
      }

      logger.info("Artifact created", { artifactId: artifactResult.data.id });

      const summary = `Filtered ${parsedCsv.rowCount} total records to ${filteredCount} matching records, sampled ${samples.length} random record(s). ${filteredCount - samples.length} record(s) left unprocessed.`;

      const { id, type, summary: artifactSummary } = artifactResult.data;

      return ok(
        { response: summary },
        {
          artifactRefs: [{ id, type, summary: artifactSummary }],
          outlineRefs: [
            {
              service: "internal",
              title: "CSV Filter",
              content: summary,
              artifactId: id,
              artifactLabel: "View Filter",
              type: "file",
            },
          ],
        },
      );
    } catch (error) {
      logger.error("csv-filter-sampler agent failed", { error });
      return err(stringifyError(error));
    }
  },
});

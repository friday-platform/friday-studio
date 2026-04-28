import { type ArtifactRef, createAgent, err, ok } from "@atlas/agent-sdk";
import { streamTextWithEvents } from "@atlas/agent-sdk/vercel-helpers";
import { ArtifactStorage } from "@atlas/core/artifacts/server";
import { registry, temporalGroundingMessage, traceModel } from "@atlas/llm";
import { stringifyError, truncateUnicode } from "@atlas/utils";
import { stepCountIs, tool } from "ai";
import { z } from "zod";

import { buildAnalysisPrompt } from "./prompts.ts";
import {
  configFromEnv,
  createDescribeTableTool,
  createExecuteSqlTool,
  createSnowflakeConnection,
  destroySnowflakeConnection,
  type QueryExecution,
  QueryExecutionSchema,
} from "./snowflake-tools.ts";

// ---------------------------------------------------------------------------
// Save analysis tool
// ---------------------------------------------------------------------------

/** Shared ref for the save_analysis tool to write into and the handler to read from. */
export interface AnalysisRef {
  summary: string | null;
}

export function createSaveAnalysisTool(ref: AnalysisRef) {
  return tool({
    description:
      "Save your final analysis summary. Call once when you have completed the analysis.",
    inputSchema: z.object({
      summary: z
        .string()
        .describe("Comprehensive analysis narrative with key metrics, trends, and insights"),
    }),
    execute: ({ summary }): { success: true } => {
      ref.summary = summary;
      return { success: true };
    },
  });
}

// ---------------------------------------------------------------------------
// Artifact creation
// ---------------------------------------------------------------------------

async function createSummaryArtifact(
  summary: string,
  question: string,
  session: { workspaceId: string; streamId?: string },
): Promise<ArtifactRef> {
  const questionSummary = truncateUnicode(question, 50, "...");

  const result = await ArtifactStorage.create({
    workspaceId: session.workspaceId,
    chatId: session.streamId,
    data: { type: "summary", version: 1, data: summary },
    title: `Snowflake Analysis: ${questionSummary}`,
    summary: truncateUnicode(summary, 200),
  });

  if (!result.ok) {
    throw new Error(`Failed to create summary artifact: ${result.error}`);
  }

  return { id: result.data.id, type: result.data.type, summary: result.data.summary };
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

const DEFAULT_QUESTION = "Analyze this table for trends, anomalies, patterns, and key insights.";

// Unquoted identifier segment: starts with letter/underscore, allows digits and $
const IDENT = "[A-Za-z_][A-Za-z0-9_$]*";
// Quoted identifier segment: anything inside double quotes (Snowflake style)
const QUOTED_IDENT = '"[^"]+"';
// A single segment is either quoted or unquoted
const SEGMENT = `(?:${QUOTED_IDENT}|${IDENT})`;
// Fully qualified: DB.SCHEMA.TABLE (three segments separated by dots)
const FQ_TABLE_RE = new RegExp(`(${SEGMENT}\\.${SEGMENT}\\.${SEGMENT})`);
// Snowflake identifier (1+ segments separated by dots)
const SNOWFLAKE_IDENT_RE = new RegExp(`(${SEGMENT}(?:\\.${SEGMENT})*)`);

/**
 * Extracts a table_name value from a JSON signal data block in the prompt.
 * The FSM appends signal data like:
 *   ## Signal Data
 *   ```json
 *   { "table_name": "DB.SCHEMA.TABLE" }
 *   ```
 */
function extractTableNameFromSignalData(prompt: string): string | null {
  const match = prompt.match(/"table_name"\s*:\s*"([^"]+)"/);
  const name = match?.[1] ?? null;
  // Reject names containing newlines — prevents prompt injection via signal data
  if (name && /[\r\n]/.test(name)) return null;
  return name;
}

/**
 * Extracts table name from the prompt. Tries three strategies in order:
 * 1. Fully qualified three-part name (DB.SCHEMA.TABLE) anywhere in the text
 * 2. Structured "table_name" field from JSON signal data block
 * 3. Falls back to empty string if neither found
 *
 * Supports both unquoted (DB.SCHEMA.TABLE) and quoted ("db"."schema"."table")
 * Snowflake identifier formats.
 */
export function parseInput(prompt: string): { tableName: string; question: string } {
  // Strategy 1: three-part FQ name anywhere in the prompt
  const fqMatch = prompt.match(FQ_TABLE_RE);
  if (fqMatch?.[1]) {
    const tableName = fqMatch[1];
    const question = prompt
      .replace(tableName, "")
      .replace(/^\s*analyze\s+(the\s+)?snowflake\s+table\s*/i, "")
      .replace(/^[.\s,;:]+/, "")
      .trim();
    return { tableName, question: question || DEFAULT_QUESTION };
  }

  // Strategy 2: extract from JSON signal data block
  const signalName = extractTableNameFromSignalData(prompt);
  if (signalName && SNOWFLAKE_IDENT_RE.test(signalName)) {
    return { tableName: signalName, question: DEFAULT_QUESTION };
  }

  return { tableName: "", question: prompt };
}

// ---------------------------------------------------------------------------
// Output schema
// ---------------------------------------------------------------------------

export const SnowflakeAnalystOutputSchema = z.object({
  summary: z.string().describe("Analysis narrative"),
  queries: z.array(QueryExecutionSchema).describe("SQL queries executed during analysis"),
});

export type SnowflakeAnalystResult = z.infer<typeof SnowflakeAnalystOutputSchema>;

// ---------------------------------------------------------------------------
// Agent definition
// ---------------------------------------------------------------------------

export const snowflakeAnalystAgent = createAgent<string, SnowflakeAnalystResult>({
  id: "snowflake-analyst",
  displayName: "Snowflake Analyst",
  version: "2.0.0",
  summary:
    "Run read-only SQL queries directly on Snowflake tables. Discover schema, analyze trends and patterns.",
  description:
    "Analytical engine for a single Snowflake table. Executes SQL queries directly on Snowflake, " +
    "discovers schema, analyzes trends, anomalies, and patterns. No data is downloaded locally. " +
    "USE FOR: analyzing a Snowflake table — revenue trends, statistical summaries, data exploration.",
  constraints:
    "READ-ONLY analysis. Requires Snowflake account credentials (account, user, password, warehouse, role). " +
    "Cannot modify data (INSERT/UPDATE/DELETE blocked). " +
    "All queries execute server-side on Snowflake.",
  outputSchema: SnowflakeAnalystOutputSchema,
  useWorkspaceSkills: true,
  expertise: {
    examples: [
      "Summarize trends in the ORDERS table over the last 30 days",
      "What are the top values by revenue in this Snowflake dataset?",
      "Find anomalies in MY_DB.PUBLIC.EVENTS",
    ],
  },
  environment: {
    required: [
      {
        name: "SNOWFLAKE_ACCOUNT",
        description: "Snowflake account identifier (e.g., xy12345.us-east-1)",
        linkRef: { provider: "snowflake", key: "account" },
      },
      {
        name: "SNOWFLAKE_USER",
        description: "Snowflake username for authentication",
        linkRef: { provider: "snowflake", key: "username" },
      },
      {
        name: "SNOWFLAKE_PASSWORD",
        description: "Snowflake password or programmatic access token",
        linkRef: { provider: "snowflake", key: "password" },
      },
      {
        name: "SNOWFLAKE_WAREHOUSE",
        description: "Snowflake compute warehouse (e.g., COMPUTE_WH)",
        linkRef: { provider: "snowflake", key: "warehouse" },
      },
      {
        name: "SNOWFLAKE_ROLE",
        description: "Snowflake role for connection (e.g., ACCOUNTADMIN)",
        linkRef: { provider: "snowflake", key: "role" },
      },
    ],
    optional: [
      { name: "SNOWFLAKE_DATABASE", description: "Default database" },
      { name: "SNOWFLAKE_SCHEMA", description: "Default schema" },
    ],
  },
  handler: async (prompt, { session, logger, abortSignal, stream, env }) => {
    const startTime = performance.now();

    // 1. Parse input
    const { tableName, question } = parseInput(prompt);
    if (!tableName) {
      return err(
        "No Snowflake table name found in prompt. " +
          "Provide a fully qualified table name like DB.SCHEMA.TABLE.",
      );
    }

    logger.info("Starting Snowflake analysis", { tableName, question: question.slice(0, 100) });

    // 2. Connect to Snowflake using credentials from environment
    let connection: Awaited<ReturnType<typeof createSnowflakeConnection>> | null = null;

    try {
      const connectionConfig = configFromEnv(env);
      connection = await createSnowflakeConnection(connectionConfig, logger);

      // 3. Build tools: execute_sql + describe_table + save_analysis
      const queryLog: QueryExecution[] = [];
      const executeSqlTool = createExecuteSqlTool(connection, logger, queryLog, abortSignal);
      const describeTableTool = createDescribeTableTool(connection, logger);
      const analysisRef: AnalysisRef = { summary: null };
      const saveAnalysisTool = createSaveAnalysisTool(analysisRef);

      // 4. Run LLM analysis loop
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Snowflake Analyst", content: `Analyzing ${tableName}...` },
      });

      const systemPrompt = buildAnalysisPrompt(tableName);

      const result = await streamTextWithEvents({
        params: {
          model: traceModel(registry.languageModel("anthropic:claude-sonnet-4-6")),
          messages: [
            { role: "system", content: systemPrompt },
            temporalGroundingMessage(),
            { role: "user", content: question },
          ],
          tools: {
            execute_sql: executeSqlTool,
            describe_table: describeTableTool,
            save_analysis: saveAnalysisTool,
          },
          stopWhen: stepCountIs(50),
          maxRetries: 3,
          abortSignal,
        },
        stream,
      });

      logger.debug("Analysis complete", { usage: result.usage, steps: result.steps?.length ?? 0 });

      if (result.finishReason === "error") {
        throw new Error("Snowflake analysis LLM returned finishReason error");
      }

      // 5. Build summary from saved analysis tool or LLM text
      const summary = analysisRef.summary ?? result.text;

      if (!summary) {
        return err("Analysis completed but the LLM produced no summary. Check query logs.");
      }

      // 6. Create artifacts
      const summaryRef = await createSummaryArtifact(summary, question, session);

      stream?.emit({
        type: "data-outline-update",
        data: {
          id: "snowflake-analyst-complete",
          title: "Snowflake Analysis Complete",
          content: truncateUnicode(summary, 200),
          timestamp: Date.now(),
          artifactId: summaryRef.id,
          artifactLabel: "View Analysis",
        },
      });

      // 7. Log metrics
      const totalDurationMs = performance.now() - startTime;
      const queryDurationMs = queryLog.reduce((sum, q) => sum + q.durationMs, 0);
      const successCount = queryLog.filter((q) => q.success).length;
      const failCount = queryLog.filter((q) => !q.success).length;
      logger.info("Snowflake analysis complete", {
        tableName,
        totalDurationMs: Math.round(totalDurationMs),
        queryDurationMs: Math.round(queryDurationMs),
        llmDurationMs: Math.round(totalDurationMs - queryDurationMs),
        queryCount: queryLog.length,
        successCount,
        failCount,
      });

      return ok({ summary, queries: queryLog }, { artifactRefs: [summaryRef] });
    } catch (error) {
      logger.error("snowflake-analyst failed", { error });
      return err(stringifyError(error));
    } finally {
      if (connection) {
        await destroySnowflakeConnection(connection, logger);
      }
    }
  },
});

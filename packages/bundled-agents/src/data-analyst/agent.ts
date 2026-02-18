import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ArtifactRef, createAgent, err, ok } from "@atlas/agent-sdk";
import { type Artifact, ArtifactStorage } from "@atlas/core/artifacts/server";
import { registry, traceModel } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { stringifyError, truncateUnicode } from "@atlas/utils";
import { getWorkspaceFilesDir } from "@atlas/utils/paths.server";
import { Database } from "@db/sqlite";
import { generateText, stepCountIs } from "ai";
import { z } from "zod";

import { buildAnalysisPrompt } from "./prompts.ts";
import { buildSchemaContext, type LoadedTableInfo } from "./schema.ts";
import {
  createExecuteSqlTool,
  createSaveResultsTool,
  type DbAttachment,
  type QueryExecution,
  QueryExecutionSchema,
  type SavedResults,
} from "./sql-tools.ts";

/** Standard UUID regex - matches both lowercase and uppercase */
const ARTIFACT_ID_REGEX = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Extracts unique UUID-formatted artifact IDs from prompt.
 * Returns empty array if none found. Deduplicates to avoid attaching the same database twice.
 */
function extractArtifactIds(prompt: string): string[] {
  const matches = prompt.match(ARTIFACT_ID_REGEX) ?? [];
  return [...new Set(matches.map((id) => id.toLowerCase()))];
}

/**
 * Extracts the analysis question by removing artifact ID references.
 * Cleans up common patterns like 'Analyze artifact <id>' prefixes.
 */
function extractQuestion(prompt: string): string {
  return prompt
    .replace(ARTIFACT_ID_REGEX, "")
    .replace(/analyze\s+artifacts?\s*/gi, "")
    .replace(/and\s+\./g, ".")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetches and validates artifacts for analysis.
 * Only accepts "database" artifacts (SQLite files converted from CSV at upload time).
 * Throws descriptive errors for missing or invalid artifacts.
 */
async function fetchAndValidateArtifacts(
  artifactIds: string[],
  logger: Logger,
): Promise<Artifact[]> {
  if (artifactIds.length === 0) {
    throw new Error("No artifact IDs found in prompt. Please specify which data to analyze.");
  }

  const result = await ArtifactStorage.getManyLatest({ ids: artifactIds });

  if (!result.ok) {
    throw new Error(`Failed to fetch artifacts: ${result.error}`);
  }

  // Build lookup map from array
  const artifactMap = new Map(result.data.map((a) => [a.id, a]));

  const results: Artifact[] = [];
  const errors: string[] = [];

  for (const id of artifactIds) {
    const artifact = artifactMap.get(id);

    if (!artifact) {
      errors.push(`Artifact ${id} not found`);
      continue;
    }

    if (artifact.data.type === "database") {
      results.push(artifact);
      continue;
    }

    errors.push(`Artifact ${id} is type ${artifact.data.type}, expected database`);
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  logger.info("Artifacts validated", { count: results.length });
  return results;
}

/**
 * Escapes single quotes for SQLite ATTACH DATABASE path.
 */
function escapeSqlitePath(path: string): string {
  return path.replace(/'/g, "''");
}

/**
 * Result of loading artifacts into the database.
 */
interface LoadArtifactsResult {
  /** Loaded table information */
  tables: LoadedTableInfo[];
  /** Database attachments for DuckDB CLI queries */
  databases: DbAttachment[];
  /** Cleanup function to remove temp files (call when done with analysis) */
  cleanup: () => Promise<void>;
}

/**
 * Loads database artifacts into the SQLite coordinator for analysis.
 *
 * Uses ATTACH DATABASE for zero-copy loading:
 * - Local paths: Attached directly
 * - Cortex paths (cortex://): Downloaded to temp file first, cleaned up via cleanup()
 *
 * Returns loaded tables with full names for SQL queries and a cleanup function.
 */
async function loadArtifactsIntoDatabase(
  artifacts: Artifact[],
  db: Database,
  logger: Logger,
): Promise<LoadArtifactsResult> {
  const tables: LoadedTableInfo[] = [];
  const databases: DbAttachment[] = [];
  const tempFiles: string[] = [];

  for (const [i, artifact] of artifacts.entries()) {
    // Type narrowing for TypeScript (validated upstream by fetchAndValidateArtifacts)
    if (artifact.data.type !== "database") {
      throw new Error(`Artifact ${artifact.id} is type ${artifact.data.type}, expected database`);
    }

    const { path, schema } = artifact.data.data;
    const alias = `db${i}`;
    let attachPath = path;

    // Handle Cortex remote storage
    if (path.startsWith("cortex://")) {
      // Create temp directory for this analysis session
      const tempDir = join(tmpdir(), `atlas-analysis-${crypto.randomUUID()}`);
      const downloadResult = await ArtifactStorage.downloadDatabaseFile({
        id: artifact.id,
        outputDir: tempDir,
      });

      if (!downloadResult.ok) {
        throw new Error(`Failed to download database: ${downloadResult.error}`);
      }

      attachPath = downloadResult.data.path;
      if (downloadResult.data.isTemporary) {
        tempFiles.push(attachPath);
      }

      logger.debug("Downloaded database from Cortex", {
        id: artifact.id,
        cortexPath: path,
        localPath: attachPath,
      });
    }

    // Collect database attachment for DuckDB CLI queries
    databases.push({ alias, path: attachPath });

    // Attach the database file to SQLite for sample data reads
    db.exec(`ATTACH DATABASE '${escapeSqlitePath(attachPath)}' AS "${alias}"`);

    // Full table name is alias.tableName
    const fullTableName = `${alias}."${schema.tableName}"`;

    // Fetch sample data for LLM context (fast SQLite read)
    const sampleData = db
      .prepare(`SELECT * FROM ${fullTableName} LIMIT 3`)
      .all<Record<string, unknown>>();

    tables.push({ tableName: fullTableName, schema, sampleData });

    logger.debug("Attached database artifact", {
      id: artifact.id,
      alias,
      tableName: schema.tableName,
      rowCount: schema.rowCount,
      remote: path.startsWith("cortex://"),
    });
  }

  // Cleanup function removes all temp files and their parent directories
  const cleanup = async () => {
    for (const tempPath of tempFiles) {
      try {
        await rm(tempPath, { force: true });
        // Also try to remove the parent temp directory if empty
        const parentDir = dirname(tempPath);
        await rm(parentDir, { recursive: true, force: true });
      } catch (error) {
        logger.warn("Failed to cleanup temp file", { tempPath, error });
      }
    }
  };

  return { tables, databases, cleanup };
}

/**
 * Runs the LLM analysis loop with SQL tools.
 * Uses generateText with tool loop, step limit, and abort handling.
 * Queries are executed via DuckDB CLI for analytical performance.
 */
async function runAnalysisLoop(
  databases: DbAttachment[],
  schemaContext: string,
  question: string,
  logger: Logger,
  queryLog: QueryExecution[],
  abortSignal?: AbortSignal,
): Promise<{ summary: string; savedResults: SavedResults | null }> {
  const executeSqlTool = createExecuteSqlTool(databases, logger, queryLog, abortSignal);
  const [saveResultsTool, getSavedResults] = createSaveResultsTool(
    databases,
    queryLog,
    abortSignal,
  );
  const analysisPrompt = buildAnalysisPrompt(schemaContext);

  const result = await generateText({
    model: traceModel(registry.languageModel("anthropic:claude-sonnet-4-6")),
    messages: [
      { role: "system", content: analysisPrompt },
      { role: "user", content: question },
    ],
    tools: { execute_sql: executeSqlTool, save_results: saveResultsTool },
    stopWhen: stepCountIs(50),
    maxRetries: 3,
    abortSignal,
  });

  logger.debug("Analysis complete", { usage: result.usage, steps: result.steps?.length ?? 0 });

  const summary = result.text || "Analysis complete but no summary generated.";

  return { summary, savedResults: getSavedResults() };
}

/**
 * Creates a summary artifact containing the analysis text.
 * Always returns an ArtifactRef; throws on creation failure.
 */
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
    title: `Analysis: ${questionSummary}`,
    summary: truncateUnicode(summary, 200),
  });

  if (!result.ok) {
    throw new Error(`Failed to create summary artifact: ${result.error}`);
  }

  return { id: result.data.id, type: result.data.type, summary: result.data.summary };
}

/**
 * Creates a data artifact with the saved query results as JSON.
 * Returns null if no results to save; throws on creation failure.
 */
async function createDataArtifact(
  savedResults: SavedResults | null,
  session: { workspaceId: string; streamId?: string },
): Promise<ArtifactRef | null> {
  if (!savedResults || savedResults.rows.length === 0) {
    return null;
  }

  const { rows, title } = savedResults;
  const workspaceFilesDir = getWorkspaceFilesDir(session.workspaceId);
  await mkdir(workspaceFilesDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = join(workspaceFilesDir, `analysis-${timestamp}.json`);
  await writeFile(filePath, JSON.stringify(rows, null, 2), "utf-8");

  const result = await ArtifactStorage.create({
    workspaceId: session.workspaceId,
    chatId: session.streamId,
    data: { type: "file", version: 1, data: { path: filePath } },
    title,
    summary: `${rows.length} rows exported to JSON`,
  });

  if (!result.ok) {
    throw new Error(`Failed to create data artifact: ${result.error}`);
  }

  return { id: result.data.id, type: result.data.type, summary: result.data.summary };
}

export const DataAnalystOutputSchema = z.object({
  summary: z.string().describe("Analysis narrative"),
  queries: z.array(QueryExecutionSchema).describe("All SQL queries executed during analysis"),
});

export type DataAnalystResult = z.infer<typeof DataAnalystOutputSchema>;

export const dataAnalystAgent = createAgent<string, DataAnalystResult>({
  id: "data-analyst",
  displayName: "Data Analyst",
  version: "1.0.0",
  description: "Analyzes tabular data to answer questions and produce actionable insights",
  outputSchema: DataAnalystOutputSchema,
  expertise: {
    domains: ["data-analysis", "sql", "reporting"],
    examples: [
      "Analyze Q4 revenue trends from this sales data",
      "What are the top performing campaigns in this dataset?",
    ],
  },
  handler: async (prompt, { session, logger, abortSignal, stream }) => {
    const startTime = performance.now();
    const artifactIds = extractArtifactIds(prompt);
    const question = extractQuestion(prompt);

    const db = new Database(":memory:");
    const queryLog: QueryExecution[] = [];
    let cleanup: (() => Promise<void>) | null = null;

    try {
      const artifacts = await fetchAndValidateArtifacts(artifactIds, logger);

      // Load artifacts into database via ATTACH DATABASE
      // - Local paths: attached directly
      // - Cortex paths: downloaded to temp files first
      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Data Analyst", content: `Loading ${artifacts.length} table(s)...` },
      });

      const loadResult = await loadArtifactsIntoDatabase(artifacts, db, logger);
      cleanup = loadResult.cleanup;

      const totalRows = loadResult.tables.reduce((sum, t) => sum + t.schema.rowCount, 0);
      if (totalRows === 0) {
        return err("All specified artifacts contain no data rows");
      }

      const schemaContext = buildSchemaContext(loadResult.tables);

      stream?.emit({
        type: "data-tool-progress",
        data: { toolName: "Data Analyst", content: "Analyzing data..." },
      });
      const { summary, savedResults } = await runAnalysisLoop(
        loadResult.databases,
        schemaContext,
        question,
        logger,
        queryLog,
        abortSignal,
      );

      const summaryRef = await createSummaryArtifact(summary, question, session);
      const dataRef = await createDataArtifact(savedResults, session);

      const artifactRefs: ArtifactRef[] = [summaryRef];
      if (dataRef) artifactRefs.push(dataRef);

      stream?.emit({
        type: "data-outline-update",
        data: {
          id: "data-analyst-complete",
          title: "Analysis Complete",
          content: truncateUnicode(summary, 200),
          timestamp: Date.now(),
          artifactId: summaryRef.id,
          artifactLabel: "View Analysis",
        },
      });

      // 9. Log timing breakdown
      const totalDurationMs = performance.now() - startTime;
      const queryDurationMs = queryLog.reduce((sum, q) => sum + q.durationMs, 0);
      const successCount = queryLog.filter((q) => q.success).length;
      const failCount = queryLog.filter((q) => !q.success).length;
      logger.info("Analysis complete", {
        totalDurationMs: Math.round(totalDurationMs),
        queryDurationMs: Math.round(queryDurationMs),
        llmDurationMs: Math.round(totalDurationMs - queryDurationMs),
        queryCount: queryLog.length,
        successCount,
        failCount,
      });

      return ok({ summary, queries: queryLog }, { artifactRefs });
    } catch (error) {
      logger.error("data-analyst failed", { error });
      return err(stringifyError(error));
    } finally {
      // Close database before cleanup (must detach before deleting temp files)
      db.close();
      // Clean up any temp files from Cortex downloads
      if (cleanup) {
        await cleanup();
      }
    }
  },
});

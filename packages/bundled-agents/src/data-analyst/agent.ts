import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type ArtifactRef, createAgent, err, ok } from "@atlas/agent-sdk";
import { type Artifact, ArtifactStorage } from "@atlas/core/artifacts/server";
import { registry, temporalGroundingMessage, traceModel } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { stringifyError, truncateUnicode } from "@atlas/utils";
import { getWorkspaceFilesDir } from "@atlas/utils/paths.server";
import { Database } from "@db/sqlite";
import { generateText, stepCountIs } from "ai";
import { z } from "zod";

import { discoverDataSources } from "./discovery.ts";
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

/** Fetches artifacts by ID. Only accepts "database" type; throws on missing or wrong type. */
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

/** Escapes single quotes for SQLite ATTACH DATABASE path. */
function escapeSqlitePath(path: string): string {
  return path.replace(/'/g, "''");
}

interface LoadArtifactsResult {
  tables: LoadedTableInfo[];
  databases: DbAttachment[];
  /** Removes temp files from Cortex downloads. Call when done with analysis. */
  cleanup: () => Promise<void>;
}

/**
 * ATTACHes database artifacts into SQLite for analysis.
 * Local paths attach directly; cortex:// paths download to temp files first.
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
    if (artifact.data.type !== "database") {
      throw new Error(`Artifact ${artifact.id} is type ${artifact.data.type}, expected database`);
    }

    const { path, schema } = artifact.data.data;
    const alias = `db${i}`;
    let attachPath = path;

    if (path.startsWith("cortex://")) {
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

    databases.push({ alias, path: attachPath });
    db.exec(`ATTACH DATABASE '${escapeSqlitePath(attachPath)}' AS "${alias}"`);

    const fullTableName = `${alias}."${schema.tableName}"`;
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

  const cleanup = async () => {
    for (const tempPath of tempFiles) {
      try {
        await rm(tempPath, { force: true });
        const parentDir = dirname(tempPath);
        await rm(parentDir, { recursive: true, force: true });
      } catch (error) {
        logger.warn("Failed to cleanup temp file", { tempPath, error });
      }
    }
  };

  return { tables, databases, cleanup };
}

/** Runs the LLM analysis loop. Queries execute via DuckDB CLI for analytical performance. */
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
      temporalGroundingMessage(),
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

/** Creates a summary artifact from the analysis text. Throws on failure. */
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

/** Creates a data artifact with saved query results. Returns null if no results. */
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
  description:
    "READ-ONLY analytical engine for uploaded database artifacts. Attaches .db files, runs exploratory SQL via DuckDB subprocess, produces summary + data artifacts. USE FOR: analyzing uploaded CSV/database artifacts — revenue trends, statistical summaries, data exploration.",
  constraints:
    "READ-ONLY. Cannot INSERT, UPDATE, or DELETE. Cannot write to workspace resource tables. Operates on uploaded database artifacts only. For CRUD on workspace resource tables, use no capability — resource_read and resource_write are built-in.",
  outputSchema: DataAnalystOutputSchema,
  expertise: {
    examples: [
      "Analyze Q4 revenue trends from this sales data",
      "What are the top performing campaigns in this dataset?",
    ],
  },
  handler: async (prompt, { session, logger, abortSignal, stream }) => {
    const startTime = performance.now();

    stream?.emit({
      type: "data-tool-progress",
      data: { toolName: "Data Analyst", content: "Identifying data sources..." },
    });
    const { question, artifactIds } = await discoverDataSources(prompt, abortSignal);

    const db = new Database(":memory:");
    const queryLog: QueryExecution[] = [];
    let cleanup: (() => Promise<void>) | null = null;

    try {
      const artifacts = await fetchAndValidateArtifacts(artifactIds, logger);
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
      db.close();
      if (cleanup) {
        await cleanup();
      }
    }
  },
});

/**
 * Fast CSV to SQLite Converter
 *
 * Uses the fastest available method:
 * 1. DuckDB CLI (4x faster, with type inference) - preferred
 * 2. SQLite CLI native .import (2.3x faster)
 * 3. JS PapaParse fallback
 */

import { spawn } from "node:child_process";
import { access, constants, stat, unlink } from "node:fs/promises";
import process from "node:process";
import { createLogger } from "@atlas/logger";
import { Database } from "@db/sqlite";
import type { DatabaseSchema, DatabaseSchemaColumn } from "../primitives.ts";
import type { ConversionResult } from "./csv-to-sqlite.ts";

const logger = createLogger({ component: "csv-converter" });

// CLI paths from environment (with fallback to PATH lookup)
const DUCKDB_PATH = process.env.ATLAS_DUCKDB_PATH ?? "duckdb";
const SQLITE3_PATH = process.env.FRIDAY_SQLITE3_PATH ?? "sqlite3";

// 10 minute timeout for CLI processes (large files can take a while)
const CLI_TIMEOUT_MS = 10 * 60 * 1000;

// Cap stderr to prevent memory exhaustion from pathological error output
const MAX_STDERR_BYTES = 64 * 1024;

export type { ConversionResult };

type CliTool = "duckdb" | "sqlite3" | null;

/**
 * Check which CLI tools are available
 */
async function checkCliAvailability(): Promise<CliTool> {
  if (await checkCommand(DUCKDB_PATH, ["--version"])) return "duckdb";
  if (await checkCommand(SQLITE3_PATH, ["--version"])) return "sqlite3";
  return null;
}

function checkCommand(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: "pipe" });
    proc.on("error", () => resolve(false));
    proc.on("close", (code: number | null) => resolve(code === 0));
  });
}

/**
 * Map DuckDB/SQLite types to our column types
 */
function normalizeColumnType(type: string): DatabaseSchemaColumn["type"] {
  const upper = type.toUpperCase();
  if (upper.includes("INT") || upper === "BIGINT") return "INTEGER";
  if (
    upper.includes("REAL") ||
    upper.includes("FLOAT") ||
    upper.includes("DOUBLE") ||
    upper === "NUMERIC"
  )
    return "REAL";
  // TEXT, VARCHAR, CHAR, etc. -> TEXT
  return "TEXT";
}

/**
 * Extract schema from SQLite database
 */
function extractSchema(db: Database, tableName: string): DatabaseSchema {
  const sanitizedTable = tableName.replace(/"/g, '""');

  const columns = db
    .prepare(`PRAGMA table_info("${sanitizedTable}")`)
    .all<{ name: string; type: string }>();

  const countResult = db
    .prepare(`SELECT COUNT(*) as count FROM "${sanitizedTable}"`)
    .get<{ count: number }>();

  return {
    tableName,
    rowCount: countResult?.count ?? 0,
    columns: columns.map((col) => ({ name: col.name, type: normalizeColumnType(col.type) })),
  };
}

/**
 * Convert using DuckDB (fastest - 4x speedup, with type inference)
 */
function convertWithDuckdb(
  csvPath: string,
  outputPath: string,
  tableName: string,
): Promise<ConversionResult> {
  const sanitizedTable = tableName.replace(/"/g, '""');
  // DuckDB uses C-style escape sequences in strings; escape backslashes first, then quotes
  const escapedCsvPath = csvPath.replace(/\\/g, "\\\\").replace(/'/g, "''");
  const escapedOutputPath = outputPath.replace(/\\/g, "\\\\").replace(/'/g, "''");

  const sql = `
    INSTALL sqlite;
    LOAD sqlite;
    ATTACH '${escapedOutputPath}' AS sqlite_db (TYPE SQLITE);
    CREATE TABLE sqlite_db."${sanitizedTable}" AS SELECT * FROM read_csv('${escapedCsvPath}');
  `;

  return new Promise((resolve, reject) => {
    const proc = spawn(DUCKDB_PATH, ["-c", sql], { stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        cleanup(outputPath);
        reject(new Error("DuckDB conversion timed out after 10 minutes"));
      }
    }, CLI_TIMEOUT_MS);

    let stderr = "";
    proc.stderr.on("data", (data) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += data.toString().slice(0, MAX_STDERR_BYTES - stderr.length);
      }
    });

    proc.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanup(outputPath);
      reject(new Error(`Failed to spawn duckdb: ${err.message}`));
    });

    proc.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        cleanup(outputPath);
        reject(new Error(`DuckDB failed (code ${code}): ${stderr}`));
        return;
      }

      try {
        const db = new Database(outputPath, { readonly: true });
        const schema = extractSchema(db, tableName);
        db.close();

        if (schema.rowCount === 0) {
          cleanup(outputPath);
          reject(new Error("CSV file is empty or has no valid rows"));
          return;
        }

        resolve({ dbPath: outputPath, schema });
      } catch (err) {
        cleanup(outputPath);
        reject(err);
      }
    });
  });
}

/**
 * Convert using SQLite CLI (2.3x speedup)
 */
function convertWithSqlite3(
  csvPath: string,
  outputPath: string,
  tableName: string,
): Promise<ConversionResult> {
  const sanitizedTable = tableName.replace(/"/g, '""');

  return new Promise((resolve, reject) => {
    const sqlite = spawn(SQLITE3_PATH, [outputPath], { stdio: ["pipe", "pipe", "pipe"] });
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        sqlite.kill();
        cleanup(outputPath);
        reject(new Error("SQLite CLI conversion timed out after 10 minutes"));
      }
    }, CLI_TIMEOUT_MS);

    let stderr = "";
    sqlite.stderr.on("data", (data) => {
      if (stderr.length < MAX_STDERR_BYTES) {
        stderr += data.toString().slice(0, MAX_STDERR_BYTES - stderr.length);
      }
    });

    sqlite.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      cleanup(outputPath);
      reject(new Error(`Failed to spawn sqlite3: ${err.message}`));
    });

    sqlite.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      if (code !== 0) {
        cleanup(outputPath);
        reject(new Error(`SQLite CLI failed (code ${code}): ${stderr}`));
        return;
      }

      try {
        const db = new Database(outputPath, { readonly: true });
        const schema = extractSchema(db, tableName);
        db.close();

        if (schema.rowCount === 0) {
          cleanup(outputPath);
          reject(new Error("CSV file is empty or has no valid rows"));
          return;
        }

        resolve({ dbPath: outputPath, schema });
      } catch (err) {
        cleanup(outputPath);
        reject(err);
      }
    });

    const escapedCsvPath = csvPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    sqlite.stdin.write(`PRAGMA journal_mode = OFF;
PRAGMA synchronous = OFF;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -64000;
.mode csv
.import "${escapedCsvPath}" "${sanitizedTable}"
`);
    sqlite.stdin.end();
  });
}

function cleanup(outputPath: string): void {
  unlink(outputPath).catch(() => {});
}

// Cache CLI availability
let availableCli: CliTool | undefined;

/** Convert CSV to SQLite using the fastest available method. */
export async function convertCsvToSqliteFast(
  csvPath: string,
  outputPath: string,
  tableName: string,
): Promise<ConversionResult> {
  // Verify input file exists and get size
  let fileSizeBytes: number;
  try {
    await access(csvPath, constants.R_OK);
    const stats = await stat(csvPath);
    fileSizeBytes = stats.size;
  } catch {
    throw new Error(`CSV file not found or not readable: ${csvPath}`);
  }

  const fileSizeMB = (fileSizeBytes / (1024 * 1024)).toFixed(2);

  // Check CLI availability (cached)
  if (availableCli === undefined) {
    availableCli = await checkCliAvailability();
    logger.info("CSV converter initialized", { method: availableCli ?? "papaparse" });
  }

  const method = availableCli ?? "papaparse";
  const startTime = performance.now();

  logger.info("CSV conversion started", {
    method,
    tableName,
    fileSizeMB: `${fileSizeMB}MB`,
    fileSizeBytes,
  });

  let result: ConversionResult;
  switch (availableCli) {
    case "duckdb":
      result = await convertWithDuckdb(csvPath, outputPath, tableName);
      break;
    case "sqlite3":
      result = await convertWithSqlite3(csvPath, outputPath, tableName);
      break;
    default: {
      // Fallback to JS implementation
      const { convertCsvToSqlite } = await import("./csv-to-sqlite.ts");
      result = await convertCsvToSqlite(csvPath, outputPath, tableName);
      break;
    }
  }

  const durationMs = Math.round(performance.now() - startTime);
  const rowsPerSecond =
    durationMs > 0
      ? Math.round(result.schema.rowCount / (durationMs / 1000))
      : result.schema.rowCount;

  logger.info("CSV conversion completed", {
    method,
    tableName,
    durationMs,
    durationSec: (durationMs / 1000).toFixed(2),
    rowCount: result.schema.rowCount,
    columnCount: result.schema.columns.length,
    fileSizeMB: `${fileSizeMB}MB`,
    rowsPerSecond,
  });

  return result;
}

/**
 * Reset CLI availability cache (useful for testing)
 */
export function resetCliCache(): void {
  availableCli = undefined;
}

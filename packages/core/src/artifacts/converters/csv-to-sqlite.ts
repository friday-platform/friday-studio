/**
 * CSV to SQLite Converter
 *
 * Stream-converts CSV file to SQLite database with constant memory usage.
 * Used at upload time to pre-process large CSVs for the data analyst agent.
 */

import { createReadStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { Database } from "@db/sqlite";
import Papa from "papaparse";
import type { DatabaseSchema } from "../primitives.ts";

/** Batch size for INSERT transactions (5000 rows per commit) */
const BATCH_SIZE = 5000;

/**
 * Result of CSV to SQLite conversion
 */
export interface ConversionResult {
  /** Path to the created SQLite database file */
  dbPath: string;
  /** Schema metadata for the converted table */
  schema: DatabaseSchema;
}

/**
 * Escape a SQL identifier (table or column name) by doubling any embedded double quotes.
 */
function escapeSqlIdentifier(name: string): string {
  return name.replace(/"/g, '""');
}

/**
 * Stream-converts CSV file to SQLite database.
 * Memory usage stays constant regardless of file size.
 *
 * Uses TEXT for all columns (SQLite handles type flexibility).
 * Papa.parse's dynamicTyping handles value conversion at read time,
 * but we store as TEXT to preserve original formatting.
 *
 * @param csvPath - Path to input CSV file
 * @param outputPath - Path for output SQLite database
 * @param tableName - Name for the table in the database
 * @returns Promise resolving to conversion result with schema metadata
 * @throws Error if CSV is empty or conversion fails
 */
export function convertCsvToSqlite(
  csvPath: string,
  outputPath: string,
  tableName: string,
): Promise<ConversionResult> {
  const db = new Database(outputPath);

  // Set pragmas for optimal conversion
  db.exec("PRAGMA journal_mode = DELETE");
  db.exec("PRAGMA page_size = 4096");

  let columns: string[] = [];
  let insertStmt: ReturnType<typeof db.prepare> | null = null;
  let batch: (string | null)[][] = [];
  let rowCount = 0;
  let tableCreated = false;

  return new Promise((resolve, reject) => {
    let stream: ReturnType<typeof createReadStream>;

    try {
      stream = createReadStream(csvPath, { encoding: "utf-8" });
    } catch (error) {
      db.close();
      cleanup(outputPath);
      reject(error);
      return;
    }

    stream.on("error", (error) => {
      db.close();
      cleanup(outputPath);
      reject(error);
    });

    Papa.parse(stream, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (header: string) => header.trim(),

      step: (row: Papa.ParseStepResult<Record<string, unknown>>) => {
        // First row: capture columns and create table
        if (!tableCreated) {
          columns = Object.keys(row.data);
          createTable(db, tableName, columns);
          insertStmt = prepareInsert(db, tableName, columns);
          tableCreated = true;
        }

        // Convert all values to strings (TEXT storage) or null
        const values = columns.map((col) => {
          const val = row.data[col];
          if (val === null || val === undefined || val === "") {
            return null;
          }
          return String(val);
        });

        batch.push(values);

        if (batch.length >= BATCH_SIZE && insertStmt) {
          flushBatch(db, insertStmt, batch);
          rowCount += batch.length;
          batch = [];
        }
      },

      complete: () => {
        // Handle empty CSV or headers-only
        if (!tableCreated || (rowCount === 0 && batch.length === 0)) {
          db.close();
          cleanup(outputPath);
          reject(new Error("CSV file is empty or has no valid rows"));
          return;
        }

        // Flush remaining batch
        if (batch.length > 0 && insertStmt) {
          flushBatch(db, insertStmt, batch);
          rowCount += batch.length;
        }

        insertStmt?.finalize();
        db.close();

        resolve({
          dbPath: outputPath,
          schema: {
            tableName,
            rowCount,
            columns: columns.map((name) => ({ name, type: "TEXT" as const })),
          },
        });
      },

      error: (error: Error) => {
        db.close();
        cleanup(outputPath);
        reject(error);
      },
    });
  });
}

/**
 * Flush batch of rows in a single transaction
 */
function flushBatch(
  db: Database,
  stmt: ReturnType<Database["prepare"]>,
  batch: (string | null)[][],
): void {
  db.exec("BEGIN TRANSACTION");
  for (const values of batch) {
    stmt.run(...values);
  }
  db.exec("COMMIT");
}

/**
 * Create table with TEXT columns
 */
function createTable(db: Database, tableName: string, columns: string[]): void {
  const sanitizedTable = escapeSqlIdentifier(tableName);
  const columnDefs = columns.map((col) => `"${escapeSqlIdentifier(col)}" TEXT`).join(", ");
  db.exec(`CREATE TABLE "${sanitizedTable}" (${columnDefs})`);
}

/**
 * Prepare parameterized INSERT statement
 */
function prepareInsert(
  db: Database,
  tableName: string,
  columns: string[],
): ReturnType<Database["prepare"]> {
  const sanitizedTable = escapeSqlIdentifier(tableName);
  const placeholders = columns.map(() => "?").join(", ");
  return db.prepare(`INSERT INTO "${sanitizedTable}" VALUES (${placeholders})`);
}

/**
 * Cleanup partial database file on error
 */
function cleanup(outputPath: string): void {
  unlink(outputPath).catch(() => {
    // Ignore cleanup errors - file may not exist
  });
}

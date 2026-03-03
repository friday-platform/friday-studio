/**
 * Upload strategy: classifies files and converts CSV to JSONB.
 *
 * - Files under 5MB: CSV → document (JSONB), markdown/txt → prose (text)
 * - Files over 5MB: any type → artifact_ref (stored as artifact)
 * - Other small files → artifact_ref
 */

import { extname } from "node:path";
import Papa from "papaparse";
import { z } from "zod";

/** Size threshold for inline storage (5MB). Files at or below this become JSONB/prose. */
const UPLOAD_SIZE_THRESHOLD = 5 * 1024 * 1024;

type UploadStrategy = "document" | "prose" | "artifact_ref";

/** Classifies a file into document (CSV), prose (markdown/txt), or artifact_ref by extension and size. */
export function classifyUpload(fileName: string, fileSize: number): UploadStrategy {
  if (fileSize > UPLOAD_SIZE_THRESHOLD) {
    return "artifact_ref";
  }

  const ext = extname(fileName).toLowerCase();

  if (ext === ".csv") {
    return "document";
  }

  if (ext === ".md" || ext === ".markdown" || ext === ".txt") {
    return "prose";
  }

  return "artifact_ref";
}

/** Schema for a CSV-derived JSONB document resource. */
export interface CsvJsonbResult {
  rows: Record<string, string>[];
  schema: { type: "object"; properties: Record<string, { type: "string" }>; required: string[] };
}

/**
 * Parses CSV text into JSONB rows and a JSON Schema.
 * All values treated as strings (no type inference).
 * @throws {Error} If the CSV has no headers or is empty.
 */
export function parseCsvToJsonb(csvText: string): CsvJsonbResult {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h: string) => h.trim(),
  });

  const headers = parsed.meta.fields;
  if (!headers || headers.length === 0) {
    throw new Error("CSV has no headers");
  }

  const properties: Record<string, { type: "string" }> = {};
  for (const h of headers) {
    properties[h] = { type: "string" };
  }

  return { rows: parsed.data, schema: { type: "object", properties, required: headers } };
}

const ProseSchema = z.object({ format: z.literal("markdown") }).passthrough();

/** Returns true if the schema describes a prose (markdown) resource. */
export function isProse(schema: unknown): boolean {
  return ProseSchema.safeParse(schema).success;
}

const TabularSchema = z.object({ properties: z.record(z.string(), z.unknown()) }).passthrough();

/** Extracts column names from a tabular JSON Schema, or returns [] if not tabular. */
export function getTabularColumns(schema: unknown): string[] {
  const result = TabularSchema.safeParse(schema);
  if (!result.success) return [];
  return Object.keys(result.data.properties);
}

/**
 * Eval result file I/O.
 *
 * Writes structured JSON to __output__/{evalName}/{timestamp}.json
 * and reads them back for post-run analysis and qualitative review.
 */

import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

/** Zod schema for eval scores (mirrors Score interface from scoring.ts). */
const ScoreSchema = z.object({
  name: z.string(),
  value: z.number(),
  reason: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** Zod schema for LLM call traces (mirrors TraceEntry from @atlas/llm). */
const TraceEntrySchema = z.object({
  type: z.enum(["generate", "stream"]),
  modelId: z.string(),
  input: z.array(z.object({ role: z.string(), content: z.unknown() })),
  output: z.object({
    text: z.string(),
    toolCalls: z.array(z.object({ name: z.string(), input: z.unknown() })),
  }),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number(), totalTokens: z.number() }),
  startMs: z.number(),
  endMs: z.number(),
});

/** Zod schema for structured eval result JSON. */
export const EvalResultSchema = z.object({
  evalName: z.string(),
  scores: z.array(ScoreSchema),
  traces: z.array(TraceEntrySchema),
  metadata: z.record(z.string(), z.unknown()),
  timestamp: z.string(),
  runId: z.string().optional(),
  tag: z.string().optional(),
});

/** Structured result from a single eval run. */
export type EvalResult = z.infer<typeof EvalResultSchema>;

/**
 * Writes an EvalResult as formatted JSON to disk.
 *
 * @param result - The eval result to persist
 * @param outputDir - Base output directory (defaults to __output__ relative to this file)
 * @returns Absolute path of the written file
 */
export async function writeEvalResult(result: EvalResult, outputDir?: string): Promise<string> {
  const baseDir = outputDir ?? join(dirname(import.meta.dirname ?? "."), "__output__");
  const safeTimestamp = result.timestamp.replace(/:/g, "-");
  const dir = join(baseDir, ...result.evalName.split("/"));
  const filepath = join(dir, `${safeTimestamp}.json`);

  await mkdir(dir, { recursive: true });
  await writeFile(filepath, JSON.stringify(result, null, 2), "utf-8");

  return filepath;
}

/** Options for filtering eval results when reading from disk. */
export interface ReadOptions {
  /** Only return the most recent result per evalName. */
  latest?: boolean;
  /** Filter to results whose runId matches this value. */
  runId?: string;
  /** Filter by evalName substring match. */
  evalName?: string;
  /** Filter to results whose tag matches this value (exact match). */
  tag?: string;
  /** Override the output directory path (defaults to __output__ relative to this file). */
  outputDir?: string;
}

/**
 * Reads eval result JSON files from an output directory.
 *
 * Globs for `*.json` files recursively, parses each through EvalResultSchema,
 * groups by evalName, and sorts by timestamp within each group.
 * Malformed or invalid files are silently skipped.
 *
 * @param options - Filtering and directory options
 * @returns Map of evalName to sorted EvalResult arrays
 */
export async function readOutputDir(options?: ReadOptions): Promise<Map<string, EvalResult[]>> {
  const baseDir = options?.outputDir ?? join(dirname(import.meta.dirname ?? "."), "__output__");
  const jsonFiles = await collectJsonFiles(baseDir);
  const grouped = new Map<string, EvalResult[]>();

  for (const filepath of jsonFiles) {
    const result = await tryParseResultFile(filepath);
    if (!result) continue;

    if (options?.runId && result.runId !== options.runId) continue;
    if (options?.evalName && !result.evalName.includes(options.evalName)) continue;
    if (options?.tag && result.tag !== options.tag) continue;

    const group = grouped.get(result.evalName) ?? [];
    group.push(result);
    grouped.set(result.evalName, group);
  }

  for (const group of grouped.values()) {
    group.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  if (options?.latest) {
    for (const [name, group] of grouped) {
      const last = group[group.length - 1];
      if (last) grouped.set(name, [last]);
    }
  }

  return grouped;
}

/**
 * Recursively collects all .json file paths under a directory.
 * Returns an empty array if the directory doesn't exist.
 */
async function collectJsonFiles(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonFiles(fullPath)));
    } else if (entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Attempts to read and parse a JSON file as an EvalResult.
 * Returns null if the file can't be read, isn't valid JSON, or fails schema validation.
 */
async function tryParseResultFile(filepath: string): Promise<EvalResult | null> {
  try {
    const raw = await readFile(filepath, "utf-8");
    const json: unknown = JSON.parse(raw);
    return EvalResultSchema.parse(json);
  } catch {
    return null;
  }
}

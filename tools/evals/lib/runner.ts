/**
 * Eval runner — imports eval files, reads their exports, executes sequentially.
 *
 * Replaces the `deno test` shelling-out approach with direct execution
 * that gives us control over output format, error isolation, and result collection.
 */

import { basename } from "node:path";
import type { EvalResult } from "./output.ts";
import type { EvalRegistration } from "./registration.ts";
import { runEval } from "./run-eval.ts";

/** Options for controlling eval execution. */
export interface RunOptions {
  /** Stop after the first eval failure. */
  failFast?: boolean;
  /** Case-insensitive substring match against eval name — non-matching evals are skipped. */
  filter?: string;
  /** Tag to attach to every result in this run (e.g., "baseline", "experiment-1"). */
  tag?: string;
}

/**
 * Imports eval files, reads their `.evals` export, and executes each
 * registration sequentially through `runEval()`.
 *
 * Errors are isolated per-eval — a failing eval is recorded as a result
 * with error metadata, and execution continues to the next eval
 * (unless `failFast` is set).
 *
 * @param files - Absolute paths to eval files
 * @param options - Execution control options (failFast, filter)
 * @returns Collected results from all evals across all files
 */
export async function executeEvals(files: string[], options?: RunOptions): Promise<EvalResult[]> {
  const runId = crypto.randomUUID();
  const filterLower = options?.filter?.toLowerCase();
  const results: EvalResult[] = [];

  for (const file of files) {
    let registrations: EvalRegistration[];

    try {
      registrations = await importEvalFile(file);
    } catch (e) {
      // File-level import failure — record a synthetic error result
      results.push(makeImportErrorResult(file, e, runId, options?.tag));
      if (options?.failFast) break;
      continue;
    }

    let broke = false;
    for (const reg of registrations) {
      if (filterLower && !reg.name.toLowerCase().includes(filterLower)) continue;

      const { result, error } = await runEval(reg.name, reg.adapter, reg.config, {
        runId,
        tag: options?.tag,
      });
      results.push(result);

      if (error && options?.failFast) {
        broke = true;
        break;
      }
    }
    if (broke) break;
  }

  return results;
}

/**
 * Dynamically imports an eval file and validates its `.evals` export.
 *
 * @throws If the file cannot be imported or has no valid `.evals` array export
 */
async function importEvalFile(file: string): Promise<EvalRegistration[]> {
  const mod = await import(file);

  if (!Array.isArray(mod.evals)) {
    throw new Error(
      `${basename(file)}: expected "evals" export to be an array, got ${typeof mod.evals}`,
    );
  }

  return mod.evals as EvalRegistration[];
}

/** Creates a synthetic EvalResult for file-level import failures. */
function makeImportErrorResult(file: string, e: unknown, runId: string, tag?: string): EvalResult {
  const message = e instanceof Error ? e.message : String(e);
  return {
    evalName: basename(file),
    scores: [],
    traces: [],
    metadata: { error: { phase: "import" as const, message }, file },
    timestamp: new Date().toISOString(),
    runId,
    ...(tag ? { tag } : {}),
  };
}

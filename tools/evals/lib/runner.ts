/**
 * Eval runner — imports eval files, reads their exports, executes with
 * bounded parallelism.
 *
 * Replaces the `deno test` shelling-out approach with direct execution
 * that gives us control over output format, error isolation, and result
 * collection. Concurrency is opt-in via `RunOptions.concurrency`; default
 * stays at 1 to match the previous sequential behavior.
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
  /**
   * Max evals running in parallel. Default 1 (sequential, preserves prior
   * behavior). Set to 4–8 for LLM-bound evals; results still come back in
   * source order regardless.
   */
  concurrency?: number;
}

/** Eval queued for execution — registration + its index in the flattened list. */
interface QueuedRegistration {
  reg: EvalRegistration;
  /** Position in the in-order result array. */
  index: number;
}

/**
 * Imports eval files, reads their `.evals` export, and executes each
 * registration through `runEval()`.
 *
 * Results are returned in source order (file order, then registration order
 * within each file) regardless of concurrency — completion order doesn't
 * leak into the result list.
 *
 * Errors are isolated per-eval — a failing eval is recorded as a result
 * with error metadata, and execution continues to the next eval
 * (unless `failFast` is set).
 *
 * @param files - Absolute paths to eval files
 * @param options - Execution control options
 * @returns Collected results from all evals across all files, in source order
 */
export async function executeEvals(files: string[], options?: RunOptions): Promise<EvalResult[]> {
  const runId = crypto.randomUUID();
  const filterLower = options?.filter?.toLowerCase();
  const concurrency = Math.max(1, options?.concurrency ?? 1);

  // 1. Import files (sequential — cheap, and import errors surface cleanly).
  const importErrors: EvalResult[] = [];
  const queue: QueuedRegistration[] = [];
  let nextIndex = 0;

  for (const file of files) {
    let registrations: EvalRegistration[];
    try {
      registrations = await importEvalFile(file);
    } catch (e) {
      importErrors.push(makeImportErrorResult(file, e, runId, options?.tag));
      // failFast on import error: don't import remaining files; queue stays as-is.
      if (options?.failFast) break;
      continue;
    }

    for (const reg of registrations) {
      if (filterLower && !reg.name.toLowerCase().includes(filterLower)) continue;
      queue.push({ reg, index: nextIndex++ });
    }
  }

  // 2. Run with bounded parallelism. Results land in `outcomes[index]`.
  const outcomes: (EvalResult | undefined)[] = new Array(queue.length);
  let stopped = false;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      if (stopped) return;
      const i = cursor++;
      if (i >= queue.length) return;
      const item = queue[i];
      if (!item) return;

      const { result, error } = await runEval(item.reg.name, item.reg.adapter, item.reg.config, {
        runId,
        tag: options?.tag,
      });
      outcomes[item.index] = result;

      if (error && options?.failFast) {
        stopped = true;
        return;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
  await Promise.all(workers);

  // 3. Stitch import errors (which appear in file order) before the registration
  //    outcomes — matches the prior file-major iteration order. Drop empty
  //    slots from failFast-skipped evals.
  return [...importErrors, ...outcomes.filter((r): r is EvalResult => r !== undefined)];
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

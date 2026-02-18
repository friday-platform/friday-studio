/**
 * Eval lifecycle wrapper.
 *
 * Orchestrates: trace scope → context creation → agent execution →
 * assertion → scoring → result writing.
 *
 * Individual eval files specify only what varies (input, run, assert, score).
 * The ceremony is handled here.
 *
 * Returns `{ result, error }` — the full EvalResult is always available,
 * even when the eval failed. This prevents data loss in the runner.
 */

import type { AgentContext } from "@atlas/agent-sdk";
import { enterTraceScope, type TraceEntry } from "@atlas/llm";
import type { AgentContextAdapter } from "./context.ts";
import { type EvalResult, writeEvalResult } from "./output.ts";
import type { Score } from "./scoring.ts";

/** Error phase for structured error reporting in eval output. */
type ErrorPhase = "execution" | "assertion" | "scoring";

/** Structured error captured during eval lifecycle. */
interface EvalError {
  phase: ErrorPhase;
  message: string;
  stack?: string;
}

/**
 * Outcome of a single eval run.
 *
 * Always contains the full `result` (with scores, traces, metadata).
 * `error` is set when any lifecycle phase failed — callers inspect this
 * to decide on failFast / exit codes without losing the real data.
 */
export interface RunEvalOutcome {
  result: EvalResult;
  error: Error | undefined;
}

/**
 * Configuration for a single eval run.
 *
 * Generic over `T` — the agent's success payload type.
 * `run` returns a result object (typically `AgentPayload<T>`), which flows
 * to `assert` and `score` callbacks.
 */
export interface EvalConfig<T> {
  /** Prompt or input data passed to the agent. */
  input: string;
  /** Executes the agent. Receives the input and a hermetic context. */
  run: (input: string, context: AgentContext) => T | Promise<T>;
  /** Optional assertion callback. Throw to fail the test. */
  assert?: (result: T, traces: TraceEntry[]) => void | Promise<void>;
  /** Optional scorer callback. Returns scores for trend analysis. */
  score?: (result: T, traces: TraceEntry[]) => Score[] | Promise<Score[]>;
  /** Arbitrary metadata stored in the output JSON (model name, config, etc.). */
  metadata?: Record<string, unknown>;
  /** Override output directory for writeEvalResult (defaults to __output__). */
  outputDir?: string;
}

/**
 * Runs a single eval through the full lifecycle: execute -> assert -> score -> write.
 *
 * Always returns the full result — never throws. Callers check `outcome.error`
 * to determine pass/fail without losing scores, traces, or metadata.
 *
 * @param name - Eval identifier, used for output path (e.g., "data-analyst/simple-query")
 * @param adapter - AgentContextAdapter for hermetic context creation
 * @param config - Eval configuration (input, run, assert, score)
 * @returns Outcome with full EvalResult and optional error
 */
export async function runEval<T>(
  name: string,
  adapter: AgentContextAdapter,
  config: EvalConfig<T>,
  options?: { runId?: string },
): Promise<RunEvalOutcome> {
  const traces: TraceEntry[] = [];
  const { context } = adapter.createContext();

  let result: T | undefined;
  let error: EvalError | undefined;
  let scores: Score[] = [];

  // Scope covers only the agent run — assert/score happen outside so
  // llmJudge traces don't contaminate agent token counts or tool fingerprints.
  await enterTraceScope(traces, async () => {
    try {
      result = await config.run(config.input, context);
    } catch (e) {
      error = toEvalError("execution", e);
    }
  });

  if (!error && config.assert) {
    try {
      await config.assert(result as T, traces);
    } catch (e) {
      error = toEvalError("assertion", e);
    }
  }

  if (result !== undefined && config.score) {
    try {
      scores = await config.score(result as T, traces);
    } catch (e) {
      error = toEvalError("scoring", e);
    }
  }

  const evalResult: EvalResult = {
    evalName: name,
    scores,
    traces,
    metadata: {
      ...config.metadata,
      input: config.input,
      ...(result !== undefined ? { result } : {}),
      ...(error ? { error } : {}),
    },
    timestamp: new Date().toISOString(),
    ...(options?.runId ? { runId: options.runId } : {}),
  };

  await writeEvalResult(evalResult, config.outputDir);

  const wrappedError = error
    ? Object.assign(new Error(`[${error.phase}] ${error.message}`), { stack: error.stack })
    : undefined;

  return { result: evalResult, error: wrappedError };
}

/** Converts an unknown thrown value to a structured EvalError. */
function toEvalError(phase: ErrorPhase, e: unknown): EvalError {
  if (e instanceof Error) {
    return { phase, message: e.message, stack: e.stack };
  }
  return { phase, message: String(e) };
}

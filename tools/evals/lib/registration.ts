/**
 * Eval registration type.
 *
 * Each eval file exports an array of EvalRegistration objects.
 * The runner imports each file, reads its `.evals` export,
 * and executes each registration through `runEval()`.
 */

import type { AgentContextAdapter } from "./context.ts";
import type { EvalConfig } from "./run-eval.ts";

/**
 * A single eval registration — the unit of execution for the custom runner.
 *
 * Eval files export `evals: EvalRegistration[]` as their convention export.
 */
export interface EvalRegistration {
  name: string;
  adapter: AgentContextAdapter;
  config: EvalConfig<unknown>;
}

/**
 * Base eval case shape — all eval files' case interfaces should extend this.
 *
 * Convention:
 * - `id`    — URL-safe path segment used in the eval name (e.g., "row-count")
 * - `name`  — human-readable display name (e.g., "simple - row count")
 * - `input` — the prompt or input string passed to the agent
 *
 * Domain-specific fields (expected values, keywords, metadata) go on the
 * extending interface. Assert/score logic stays in the registration mapping,
 * not on the case object.
 */
export interface BaseEvalCase {
  id: string;
  name: string;
  input: string;
}

/**
 * Typed builder for EvalRegistration.
 *
 * Preserves the generic `T` across `run` and `score` callbacks,
 * then widens to `EvalConfig<unknown>` for the registration array.
 * Without this, inline `EvalRegistration` literals erase `T` to `unknown`
 * and score callbacks can't access the result shape.
 *
 * The cast is safe because `runEval` passes `run()`'s return value directly
 * to `score()` / `assert()` — the generic is internally consistent.
 * TypeScript lacks existential types, so this is the standard workaround.
 */
export function defineEval<T>(reg: {
  name: string;
  adapter: AgentContextAdapter;
  config: EvalConfig<T>;
}): EvalRegistration {
  // Safe: EvalConfig<T> callbacks are internally consistent (run returns T,
  // score/assert receive T). The widening to unknown is a type-level operation
  // only — the runtime value flows correctly through runEval's generic.
  return reg as unknown as EvalRegistration;
}

/**
 * Planner eval platform-model helper.
 *
 * Builds a `PlatformModels` resolver for planner evals, with optional
 * override of the "planner" role via `PLANNER_EVAL_MODEL` env var.
 *
 * Used by the task #7 gate to compare candidate models (e.g., Haiku) against
 * the current default (Sonnet). Without the env var, evals use the built-in
 * default chain — run that path as the baseline tag, then re-run with
 * `PLANNER_EVAL_MODEL=anthropic:claude-haiku-4-5` tagged as the candidate,
 * and diff via `deno task evals compare --before <baseline> --after <candidate>`.
 */

import process from "node:process";
import { createPlatformModels, type PlatformModels } from "@atlas/llm";

/**
 * Construct a `PlatformModels` for planner evals. When `PLANNER_EVAL_MODEL`
 * is set, it overrides the "planner" role; otherwise returns the default
 * chain resolver. All other roles keep their defaults.
 */
export function createPlannerEvalPlatformModels(): PlatformModels {
  const override = process.env.PLANNER_EVAL_MODEL;
  if (override && override.trim().length > 0) {
    return createPlatformModels({ models: { planner: override.trim() } });
  }
  return createPlatformModels(null);
}

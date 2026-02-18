/**
 * Eval baseline extraction and formatting.
 *
 * Converts eval results into a compact baseline format suitable for
 * git-committed regression detection. Each eval gets ~5 lines in the
 * JSON output, making PR diffs reviewable.
 */

import { z } from "zod";
import type { EvalResult } from "./output.ts";

/** Zod schema for a single eval's behavioral fingerprint. */
export const BaselineEntrySchema = z.object({
  pass: z.boolean(),
  scores: z.record(z.string(), z.number()),
  toolCalls: z.array(z.string()),
  turns: z.number(),
  error: z.object({ phase: z.string() }).nullable(),
});

/** Behavioral fingerprint for a single eval. */
export type BaselineEntry = z.infer<typeof BaselineEntrySchema>;

/** Zod schema for a complete baseline snapshot. */
export const BaselineSchema = z.object({
  generatedAt: z.string(),
  generatedFrom: z.string(),
  evals: z.record(z.string(), BaselineEntrySchema),
});

/** Complete baseline snapshot. */
export type Baseline = z.infer<typeof BaselineSchema>;

/** Schema for error metadata embedded in EvalResult.metadata.error. */
const ErrorMetaSchema = z.object({ phase: z.string(), message: z.string() });

/**
 * Extracts a baseline from grouped eval results.
 *
 * Uses the latest (last) result per evalName. Captures pass/fail state,
 * score values, ordered tool call names, LLM turn count, and error phase.
 *
 * @param grouped - Map of evalName to sorted EvalResult arrays (from readOutputDir)
 * @param commitHash - Git commit hash to record as generation source
 * @returns Complete baseline snapshot
 */
export function extractBaseline(grouped: Map<string, EvalResult[]>, commitHash: string): Baseline {
  const evals: Record<string, BaselineEntry> = {};

  for (const [, results] of grouped) {
    const latest = results[results.length - 1];
    if (!latest) continue;

    const errorParsed = ErrorMetaSchema.safeParse(latest.metadata.error);
    const hasError = errorParsed.success;

    const scores: Record<string, number> = {};
    for (const s of latest.scores) {
      scores[s.name] = s.value;
    }

    const toolCalls: string[] = [];
    for (const trace of latest.traces) {
      for (const tc of trace.output.toolCalls) {
        toolCalls.push(tc.name);
      }
    }

    evals[latest.evalName] = {
      pass: !hasError,
      scores,
      toolCalls,
      turns: latest.traces.length,
      error: hasError ? { phase: errorParsed.data.phase } : null,
    };
  }

  return { generatedAt: new Date().toISOString(), generatedFrom: commitHash, evals };
}

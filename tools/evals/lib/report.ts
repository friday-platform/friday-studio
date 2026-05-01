/**
 * Eval report builder and formatters.
 *
 * Transforms grouped EvalResult data into a structured report
 * with per-eval rows and an aggregate summary.
 */

import type { EvalResult } from "./output.ts";
import { aggregateScores } from "./scoring.ts";

/** A single row in the eval report. */
export interface ReportRow {
  evalName: string;
  passed: boolean;
  scores: Record<string, number>;
  tokens: number;
}

/** Aggregate summary across all report rows. */
export interface ReportSummary {
  total: number;
  passed: number;
  failed: number;
  avgScore: number;
  totalTokens: number;
}

/** Complete report with per-eval rows and aggregate summary. */
export interface Report {
  rows: ReportRow[];
  summary: ReportSummary;
}

/**
 * Builds a report from grouped eval results.
 *
 * Uses the latest (last) result per evalName. An eval is considered
 * failed if its metadata contains an `error` property.
 *
 * @param grouped - Map of evalName to sorted EvalResult arrays (from readOutputDir)
 */
export function buildReport(grouped: Map<string, EvalResult[]>): Report {
  const rows: ReportRow[] = [];

  for (const [, results] of grouped) {
    const latest = results[results.length - 1];
    if (!latest) continue;

    const scores: Record<string, number> = {};
    for (const s of latest.scores) {
      scores[s.name] = s.value;
    }

    const tokens = latest.traces.reduce(
      (sum, t) => sum + t.usage.inputTokens + t.usage.outputTokens,
      0,
    );
    const passed = !latest.metadata.error;

    rows.push({ evalName: latest.evalName, passed, scores, tokens });
  }

  rows.sort((a, b) => a.evalName.localeCompare(b.evalName));

  const allScores = rows.flatMap((r) =>
    Object.values(r.scores).map((value) => ({ name: "", value })),
  );

  const summary: ReportSummary = {
    total: rows.length,
    passed: rows.filter((r) => r.passed).length,
    failed: rows.filter((r) => !r.passed).length,
    avgScore: aggregateScores(allScores),
    totalTokens: rows.reduce((sum, r) => sum + r.tokens, 0),
  };

  return { rows, summary };
}

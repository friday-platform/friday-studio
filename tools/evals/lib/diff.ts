/**
 * Baseline diff logic for eval regression detection.
 *
 * Compares a committed baseline against current eval results,
 * producing per-eval deltas and an aggregate summary.
 */

import type { Baseline, BaselineEntry } from "./baseline.ts";

/** Classification of an eval's change between baseline and current. */
export type DiffStatus = "improved" | "regressed" | "unchanged" | "new" | "removed";

/** Per-eval diff showing what changed. */
export interface EvalDiff {
  evalName: string;
  status: DiffStatus;
  baseline: BaselineEntry | null;
  current: BaselineEntry | null;
  scoreDeltas: Record<string, number>;
  passFlip: null | { from: boolean; to: boolean };
  toolCallsChanged: boolean;
  turnsDelta: number;
}

/** Aggregate summary of all diffs. */
export interface DiffSummary {
  improved: number;
  regressed: number;
  unchanged: number;
  new: number;
  removed: number;
}

/** Complete diff result. */
export interface DiffResult {
  diffs: EvalDiff[];
  summary: DiffSummary;
}

/**
 * Computes per-eval diffs between a baseline and current results.
 *
 * @param baseline - The committed baseline snapshot
 * @param current - Current results extracted as a Baseline (same shape)
 */
export function computeDiff(baseline: Baseline, current: Baseline): DiffResult {
  const allNames = new Set([...Object.keys(baseline.evals), ...Object.keys(current.evals)]);

  const diffs: EvalDiff[] = [];

  for (const evalName of allNames) {
    const base = baseline.evals[evalName] ?? null;
    const curr = current.evals[evalName] ?? null;

    if (!base) {
      diffs.push({
        evalName,
        status: "new",
        baseline: null,
        current: curr,
        scoreDeltas: {},
        passFlip: null,
        toolCallsChanged: false,
        turnsDelta: 0,
      });
      continue;
    }

    if (!curr) {
      diffs.push({
        evalName,
        status: "removed",
        baseline: base,
        current: null,
        scoreDeltas: {},
        passFlip: null,
        toolCallsChanged: false,
        turnsDelta: 0,
      });
      continue;
    }

    const scoreDeltas: Record<string, number> = {};
    const allScoreNames = new Set([...Object.keys(base.scores), ...Object.keys(curr.scores)]);
    for (const name of allScoreNames) {
      const baseVal = base.scores[name] ?? 0;
      const currVal = curr.scores[name] ?? 0;
      scoreDeltas[name] = currVal - baseVal;
    }

    const passFlip = base.pass !== curr.pass ? { from: base.pass, to: curr.pass } : null;

    const toolCallsChanged = JSON.stringify(base.toolCalls) !== JSON.stringify(curr.toolCalls);

    const turnsDelta = curr.turns - base.turns;

    const status = classifyStatus(passFlip, scoreDeltas, toolCallsChanged);

    diffs.push({
      evalName,
      status,
      baseline: base,
      current: curr,
      scoreDeltas,
      passFlip,
      toolCallsChanged,
      turnsDelta,
    });
  }

  diffs.sort((a, b) => a.evalName.localeCompare(b.evalName));

  const summary: DiffSummary = {
    improved: diffs.filter((d) => d.status === "improved").length,
    regressed: diffs.filter((d) => d.status === "regressed").length,
    unchanged: diffs.filter((d) => d.status === "unchanged").length,
    new: diffs.filter((d) => d.status === "new").length,
    removed: diffs.filter((d) => d.status === "removed").length,
  };

  return { diffs, summary };
}

/**
 * Classifies whether an eval improved, regressed, or stayed unchanged.
 *
 * Regression = pass->fail, any score decreased, or tool calls changed unexpectedly.
 * Improvement = fail->pass or any score increased (with none decreased).
 */
function classifyStatus(
  passFlip: { from: boolean; to: boolean } | null,
  scoreDeltas: Record<string, number>,
  toolCallsChanged: boolean,
): DiffStatus {
  const deltas = Object.values(scoreDeltas);
  const anyDecreased = deltas.some((d) => d < -0.001);
  const anyIncreased = deltas.some((d) => d > 0.001);

  if (passFlip?.from === true && passFlip.to === false) return "regressed";
  if (passFlip?.from === false && passFlip.to === true) return "improved";
  if (anyDecreased) return "regressed";
  if (anyIncreased) return "improved";
  // Behavioral change without score movement counts as regression
  if (toolCallsChanged) return "regressed";

  return "unchanged";
}

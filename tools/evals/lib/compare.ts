/**
 * Run comparison engine for eval tuning.
 *
 * Compares two sets of EvalResults (before/after) and classifies each eval
 * as improved, regressed, or unchanged. Operates on full EvalResult objects,
 * not baseline fingerprints.
 */

import type { EvalResult } from "./output.ts";

/** Options for compareRuns. */
export interface CompareOptions {
  /** Include scoreReasons and promptDiff in entries. */
  verbose?: boolean;
  /** Label for the "before" run (default: "before"). */
  beforeLabel?: string;
  /** Label for the "after" run (default: "after"). */
  afterLabel?: string;
}

/** A single eval's comparison entry. */
export interface CompareEntry {
  evalName: string;
  before: { pass: boolean; scores: Record<string, number>; result?: unknown };
  after: { pass: boolean; scores: Record<string, number>; result?: unknown };
  /** Present only in verbose mode. */
  scoreReasons?: { before: Record<string, string>; after: Record<string, string> };
  /** Present only in verbose mode when both runs have metadata.promptSnapshot. */
  promptDiff?: string;
}

/** Aggregate comparison summary. */
export interface CompareSummary {
  total: number;
  improved: number;
  regressed: number;
  unchanged: number;
  beforePass: number;
  afterPass: number;
}

/** Full comparison result. */
export interface CompareResult {
  before: string;
  after: string;
  summary: CompareSummary;
  improved: CompareEntry[];
  regressed: CompareEntry[];
  unchanged: CompareEntry[];
  /** Evals present only in the "after" run. */
  addedEvals?: string[];
  /** Evals present only in the "before" run. */
  removedEvals?: string[];
}

/**
 * Compares two sets of eval results and produces a structured comparison.
 *
 * @param before - Results from the baseline/before run
 * @param after - Results from the experiment/after run
 * @param options - Labels and verbose mode
 */
export function compareRuns(
  before: EvalResult[],
  after: EvalResult[],
  options?: CompareOptions,
): CompareResult {
  const beforeMap = deduplicateByEvalName(before);
  const afterMap = deduplicateByEvalName(after);

  const allNames = new Set([...beforeMap.keys(), ...afterMap.keys()]);

  const improved: CompareEntry[] = [];
  const regressed: CompareEntry[] = [];
  const unchanged: CompareEntry[] = [];
  const addedEvals: string[] = [];
  const removedEvals: string[] = [];

  let beforePass = 0;
  let afterPass = 0;

  for (const evalName of allNames) {
    const b = beforeMap.get(evalName);
    const a = afterMap.get(evalName);

    if (!b) {
      addedEvals.push(evalName);
      if (a && isPassing(a)) afterPass++;
      continue;
    }

    if (!a) {
      removedEvals.push(evalName);
      if (isPassing(b)) beforePass++;
      continue;
    }

    const bPass = isPassing(b);
    const aPass = isPassing(a);
    if (bPass) beforePass++;
    if (aPass) afterPass++;

    const bScores = extractScores(b);
    const aScores = extractScores(a);

    const status = classify(bPass, aPass, bScores, aScores);

    const entry = buildEntry(evalName, b, a, bPass, aPass, bScores, aScores, status, options);

    if (status === "improved") improved.push(entry);
    else if (status === "regressed") regressed.push(entry);
    else unchanged.push(entry);
  }

  return {
    before: options?.beforeLabel ?? "before",
    after: options?.afterLabel ?? "after",
    summary: {
      total: allNames.size,
      improved: improved.length,
      regressed: regressed.length,
      unchanged: unchanged.length,
      beforePass,
      afterPass,
    },
    improved,
    regressed,
    unchanged,
    ...(addedEvals.length > 0 ? { addedEvals } : {}),
    ...(removedEvals.length > 0 ? { removedEvals } : {}),
  };
}

/**
 * Deduplicates results by evalName, keeping the one from the latest timestamp.
 * When multiple results share an evalName, the one with the latest timestamp wins.
 */
function deduplicateByEvalName(results: EvalResult[]): Map<string, EvalResult> {
  const map = new Map<string, EvalResult>();
  for (const r of results) {
    const existing = map.get(r.evalName);
    if (!existing || r.timestamp > existing.timestamp) {
      map.set(r.evalName, r);
    }
  }
  return map;
}

/** An eval passes when it has no error in metadata. */
function isPassing(result: EvalResult): boolean {
  return !result.metadata.error;
}

/** Extracts scores as a name→value record. */
function extractScores(result: EvalResult): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const s of result.scores) {
    scores[s.name] = s.value;
  }
  return scores;
}

/** Extracts score reasons as a name→reason record. */
function extractScoreReasons(result: EvalResult): Record<string, string> {
  const reasons: Record<string, string> = {};
  for (const s of result.scores) {
    if (s.reason) reasons[s.name] = s.reason;
  }
  return reasons;
}

/**
 * Classifies the change between before and after.
 *
 * - pass→fail = regressed
 * - fail→pass = improved
 * - any score decreased = regressed
 * - any score increased (none decreased) = improved
 * - otherwise = unchanged
 */
function classify(
  beforePass: boolean,
  afterPass: boolean,
  beforeScores: Record<string, number>,
  afterScores: Record<string, number>,
): "improved" | "regressed" | "unchanged" {
  if (beforePass && !afterPass) return "regressed";
  if (!beforePass && afterPass) return "improved";

  const allScoreNames = new Set([...Object.keys(beforeScores), ...Object.keys(afterScores)]);
  let anyDecreased = false;
  let anyIncreased = false;

  for (const name of allScoreNames) {
    const bVal = beforeScores[name] ?? 0;
    const aVal = afterScores[name] ?? 0;
    const delta = aVal - bVal;
    if (delta < -0.001) anyDecreased = true;
    if (delta > 0.001) anyIncreased = true;
  }

  if (anyDecreased) return "regressed";
  if (anyIncreased) return "improved";
  return "unchanged";
}

/** Builds a CompareEntry, using compact form for unchanged passing cases. */
function buildEntry(
  evalName: string,
  before: EvalResult,
  after: EvalResult,
  beforePass: boolean,
  afterPass: boolean,
  beforeScores: Record<string, number>,
  afterScores: Record<string, number>,
  status: "improved" | "regressed" | "unchanged",
  options?: CompareOptions,
): CompareEntry {
  // Compact form for unchanged passing cases: no scores, no result
  if (status === "unchanged" && beforePass && afterPass) {
    return { evalName, before: { pass: true, scores: {} }, after: { pass: true, scores: {} } };
  }

  const entry: CompareEntry = {
    evalName,
    before: {
      pass: beforePass,
      scores: beforeScores,
      ...(before.metadata.result !== undefined ? { result: before.metadata.result } : {}),
    },
    after: {
      pass: afterPass,
      scores: afterScores,
      ...(after.metadata.result !== undefined ? { result: after.metadata.result } : {}),
    },
  };

  if (options?.verbose) {
    entry.scoreReasons = { before: extractScoreReasons(before), after: extractScoreReasons(after) };

    const bSnapshot = before.metadata.promptSnapshot;
    const aSnapshot = after.metadata.promptSnapshot;
    if (typeof bSnapshot === "string" && typeof aSnapshot === "string") {
      entry.promptDiff = buildSimpleDiff(bSnapshot, aSnapshot);
    }
  }

  return entry;
}

/** Produces a simple line-by-line diff of two strings. */
function buildSimpleDiff(before: string, after: string): string {
  const bLines = before.split("\n");
  const aLines = after.split("\n");
  const lines: string[] = [];

  const max = Math.max(bLines.length, aLines.length);
  for (let i = 0; i < max; i++) {
    const bLine = bLines[i];
    const aLine = aLines[i];
    if (bLine === aLine) {
      lines.push(` ${bLine}`);
    } else {
      if (bLine !== undefined) lines.push(`-${bLine}`);
      if (aLine !== undefined) lines.push(`+${aLine}`);
    }
  }

  return lines.join("\n");
}

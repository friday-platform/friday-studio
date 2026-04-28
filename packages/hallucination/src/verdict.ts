/**
 * Validation verdict shape returned by the hallucination judge.
 *
 * Replaces the binary `{ valid, feedback }` envelope. Status is derived in code
 * (not picked by the judge) from a confidence-band → supervision-threshold mapping;
 * severity is derived from category via a static map. See the design doc:
 * `docs/plans/2026-04-28-fine-grained-validation-verdict-design.md`.
 *
 * NOTE: "Validator (Workspace)" in `@atlas/config` is a different concept; this
 * module is the post-hoc Output Validator (Hallucination Judge) — runtime, LLM-driven.
 */

import { SupervisionLevel } from "./supervision-levels.ts";

export type VerdictStatus = "pass" | "uncertain" | "fail";
export type IssueCategory = "sourcing" | "no-tools-called" | "judge-uncertain" | "judge-error";
export type IssueSeverity = "info" | "warn" | "error";

export interface ValidationIssue {
  category: IssueCategory;
  severity: IssueSeverity;
  claim: string;
  reasoning: string;
  citation: string | null;
}

export interface ValidationVerdict {
  status: VerdictStatus;
  confidence: number;
  threshold: number;
  issues: ValidationIssue[];
  retryGuidance: string;
}

/**
 * Confidence threshold per supervision level. Above-threshold → pass; below 0.3 → fail;
 * the band in between is uncertain (proceeds with a soft warning).
 */
const SUPERVISION_THRESHOLDS: Readonly<Record<SupervisionLevel, number>> = {
  [SupervisionLevel.MINIMAL]: 0.35,
  [SupervisionLevel.STANDARD]: 0.45,
  [SupervisionLevel.PARANOID]: 0.6,
};

/** Hard floor below which any verdict is `fail` regardless of supervision level. */
const FAIL_FLOOR = 0.3;

/** Synthetic confidence used when the judge itself fails (never < FAIL_FLOOR). */
const JUDGE_ERROR_CONFIDENCE = 0.4;

/**
 * Static category → severity map. Severity is policy, not observation —
 * keeping the judge out of severity selection prevents prompt-induced loops.
 */
const SEVERITY_BY_CATEGORY: Readonly<Record<IssueCategory, IssueSeverity>> = {
  sourcing: "error",
  "no-tools-called": "warn",
  "judge-uncertain": "info",
  "judge-error": "info",
};

export function severityForCategory(category: IssueCategory): IssueSeverity {
  return SEVERITY_BY_CATEGORY[category];
}

export function getThresholdForLevel(level: SupervisionLevel): number {
  return SUPERVISION_THRESHOLDS[level];
}

/**
 * Map a confidence score against a supervision threshold to a verdict status.
 * `confidence >= threshold` → pass; `[FAIL_FLOOR, threshold)` → uncertain; below → fail.
 */
export function statusFromConfidence(confidence: number, threshold: number): VerdictStatus {
  if (confidence >= threshold) return "pass";
  if (confidence >= FAIL_FLOOR) return "uncertain";
  return "fail";
}

/**
 * Build a synthetic verdict for judge infrastructure failures (network, parse, rate-limit, crash).
 * Status is forced uncertain so agent work is never lost to validator outages.
 */
export function judgeErrorVerdict(threshold: number, message: string): ValidationVerdict {
  const issue: ValidationIssue = {
    category: "judge-error",
    severity: severityForCategory("judge-error"),
    claim: "",
    reasoning: message,
    citation: null,
  };
  return {
    status: "uncertain",
    confidence: JUDGE_ERROR_CONFIDENCE,
    threshold,
    issues: [issue],
    retryGuidance: "",
  };
}

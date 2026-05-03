/**
 * Validation verdict shape returned by the hallucination judge.
 *
 * Replaces the binary `{ valid, feedback }` envelope. Status is derived in code
 * (not picked by the judge) from a confidence-band → supervision-threshold mapping;
 * severity is derived from category via a static map.
 *
 * NOTE: "Validator (Workspace)" in `@atlas/config` is a different concept; this
 * module is the post-hoc Output Validator (Hallucination Judge) — runtime, LLM-driven.
 */

import { z } from "zod";
import { SupervisionLevel } from "./supervision-levels.ts";

export const VerdictStatusSchema = z.enum(["pass", "uncertain", "fail"]);
export type VerdictStatus = z.infer<typeof VerdictStatusSchema>;

export const IssueCategorySchema = z.enum([
  "sourcing",
  "no-tools-called",
  "judge-uncertain",
  "judge-error",
]);
export type IssueCategory = z.infer<typeof IssueCategorySchema>;

export const IssueSeveritySchema = z.enum(["info", "warn", "error"]);
export type IssueSeverity = z.infer<typeof IssueSeveritySchema>;

export const ValidationIssueSchema = z.object({
  category: IssueCategorySchema,
  severity: IssueSeveritySchema,
  claim: z.string(),
  reasoning: z.string(),
  citation: z.string().nullable(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const ValidationVerdictSchema = z.object({
  status: VerdictStatusSchema,
  confidence: z.number(),
  threshold: z.number(),
  issues: z.array(ValidationIssueSchema),
  retryGuidance: z.string(),
});
export type ValidationVerdict = z.infer<typeof ValidationVerdictSchema>;

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

/**
 * Thrown by validation consumers when a verdict's status is `fail`.
 * Carries the full verdict so callers can render structured issues, log
 * confidence, or attach the payload to a lifecycle event.
 */
export class ValidationFailedError extends Error {
  constructor(
    public readonly verdict: ValidationVerdict,
    agentId?: string,
  ) {
    const subject = agentId ? `agent ${agentId}` : "agent output";
    const guidance = verdict.retryGuidance || "no retry guidance";
    super(`Validation failed for ${subject}: ${guidance}`);
    this.name = "ValidationFailedError";
  }
}

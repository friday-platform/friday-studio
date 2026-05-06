/**
 * Validation verdict shape returned by the external judge agent (B7 of
 * melodic-strolling-seal-pt2).
 *
 * Phase B7 collapsed the heavy hallucination/detector.ts machinery (~700
 * lines of generateObject + retry + error classification) into a delegate
 * call to `@friday/judge-agent`. The shapes that survive here are the
 * narrow data contract the FSM engine emits on `step:complete.validation`
 * and that the judge agent populates as its `outputType: validation-verdict`.
 *
 * NOTE: "Validator (Workspace)" in `@atlas/config` is a different concept;
 * this module is the post-hoc Output Validator (Hallucination Judge) —
 * runtime, agent-driven.
 */

import { z } from "zod";

export const VerdictStatusSchema = z.enum(["pass", "advisory", "blocking"]);
export type VerdictStatus = z.infer<typeof VerdictStatusSchema>;

/**
 * Issue category. Authors and the judge agent both use these — strings on
 * the wire, enum-typed in code. `judge-error` is reserved for runtime
 * synthesis when the judge delegate itself fails (budget exhausted, agent
 * not found, exception); the judge prompt forbids emitting it directly.
 */
export const IssueCategorySchema = z.enum([
  "sourcing",
  "no-tools-called",
  "judge-uncertain",
  "judge-error",
]);
export type IssueCategory = z.infer<typeof IssueCategorySchema>;

/**
 * Severity buckets surfaced on `step:complete.validation.issues[].severity`.
 * Kept as a structural superset of what authors can hand to
 * `record_validation` (B6) so the judge-derived shape parses cleanly into
 * the same emit envelope.
 */
export const IssueSeveritySchema = z.enum(["low", "medium", "high", "info", "warn", "error"]);
export type IssueSeverity = z.infer<typeof IssueSeveritySchema>;

export const ValidationIssueSchema = z.object({
  category: IssueCategorySchema.optional(),
  severity: IssueSeveritySchema.optional(),
  claim: z.string(),
  reasoning: z.string().optional(),
  citation: z.string().nullable().optional(),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

/**
 * Verdict the judge agent emits as its structured `validation-verdict`
 * output, also the shape FSM engine carries forward to
 * `step:complete.validation`. The discriminator is `verdict`, not
 * `status` — matches B6's emit-side enum and keeps the judge prompt
 * conceptually aligned with `record_validation`.
 *
 * - `pass`     — output is sourced; emit normally.
 * - `advisory` — output emitted with concerns; never gates the action.
 * - `blocking` — fabrication; runtime errors the action and the FSM does
 *                not transition.
 *
 * Legacy (pre-B7) consumers also read `status`/`confidence`/`threshold`/
 * `retryGuidance`. These are kept on the schema as optional fields so the
 * UI components that grew up around the pre-B7 shape continue to render
 * the same pills without per-component refactors. The judge agent does
 * not emit them; runtime sites that build verdicts populate them only
 * for back-compat where it matters.
 */
export const ValidationVerdictSchema = z.object({
  verdict: VerdictStatusSchema,
  issues: z.array(ValidationIssueSchema).optional(),
  /** @deprecated B7 — legacy mirror of `verdict`. New code reads `verdict`. */
  status: z.enum(["pass", "uncertain", "fail"]).optional(),
  /** @deprecated B7 — pre-B7 confidence band; not produced by the judge agent. */
  confidence: z.number().optional(),
  /** @deprecated B7 — pre-B7 supervision threshold; not produced by the judge agent. */
  threshold: z.number().optional(),
  /** @deprecated B7 — pre-B7 retry hint; the new path doesn't auto-retry. */
  retryGuidance: z.string().optional(),
});
export type ValidationVerdict = z.infer<typeof ValidationVerdictSchema>;

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

/**
 * Thrown by validation consumers when the judge returns `verdict: "blocking"`.
 * Carries the verdict so callers (Task #29 system error chunk renderer) can
 * inspect issues without re-parsing strings.
 */
export class ValidationFailedError extends Error {
  constructor(
    public readonly verdict: ValidationVerdict,
    agentId?: string,
  ) {
    const subject = agentId ? `agent ${agentId}` : "agent output";
    const issues = verdict.issues?.map((i) => i.claim).join("; ") || "no issues";
    super(`Validation failed for ${subject}: ${issues}`);
    this.name = "ValidationFailedError";
  }
}

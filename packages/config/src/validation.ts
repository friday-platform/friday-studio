/**
 * Validation defaults (Phase B5 of melodic-strolling-seal-pt2).
 *
 * Workspace- and per-job-level defaults for the LLM-output validation
 * policy that the FSM engine resolves per action. Mirrors the
 * permissions.ts / delegation.ts pattern: the schema lives in its own
 * file so jobs.ts and workspace.ts can both import it without creating
 * a cycle, and the resolver helper lives alongside it.
 *
 * Precedence at action-execution time (highest wins):
 *   action.validate
 *     > job.validation.default
 *     > workspace.validation.default
 *     > "auto"  (the B1 classifier)
 *
 * Skill name follows the same merge: explicit object-form override on
 * the action wins, then job, then workspace, then the package default.
 *
 * Default of "auto" everywhere preserves the B1 classifier behavior for
 * unmodified workspaces — no migration required.
 */
import { z } from "zod";

export const ValidationDefaultsSchema = z.strictObject({
  /**
   * Default validation strategy applied to LLM/agent actions when the
   * action itself doesn't set `validate:`. Mirrors the string form of
   * `ValidateStrategySchema` in fsm-engine/schema.ts (object form is
   * action-scoped only — defaults stay flat).
   */
  default: z.enum(["auto", "skip", "self", "external"]).optional(),
  /**
   * Default skill name used when the resolved strategy is `self` (or
   * `external` once B7 lands the validator-agent delegate). Action-level
   * object-form `validate.skill` still wins.
   */
  skill: z.string().optional(),
});

export type ValidationDefaults = z.infer<typeof ValidationDefaultsSchema>;

/**
 * Default validating skill — used when no level (action / job /
 * workspace) supplies an override. Matches `DEFAULT_VALIDATION_SKILL`
 * referenced by `composeValidationBlock` (see core/agent-context).
 */
export const DEFAULT_VALIDATION_SKILL = "validating-llm-outputs";

export interface ResolveValidationInput {
  /**
   * Action-level setting, already normalized from the `ValidateStrategy`
   * union form (string | object) into a flat `{strategy, skill}` shape.
   * Use `normalizeActionValidate` from this module to do that conversion.
   */
  action?: { strategy?: "auto" | "skip" | "self" | "external"; skill?: string };
  job?: ValidationDefaults;
  workspace?: ValidationDefaults;
}

export interface ResolvedValidation {
  strategy: "auto" | "skip" | "self" | "external";
  /** Resolved skill name; defaults to DEFAULT_VALIDATION_SKILL. */
  skill: string;
}

/**
 * Compute the effective validation strategy + skill at action-execution
 * time. Action > job > workspace > "auto" (classifier). Skill resolution
 * follows the same precedence; falls back to DEFAULT_VALIDATION_SKILL
 * when nothing is set.
 *
 * `strategy: "auto"` from this helper still hands off to the B1
 * classifier — callers should treat "auto" as a sentinel meaning "run
 * the classifier", not as a final decision.
 */
export function resolveValidation(input: ResolveValidationInput): ResolvedValidation {
  const strategy =
    input.action?.strategy ?? input.job?.default ?? input.workspace?.default ?? "auto";
  const skill =
    input.action?.skill ?? input.job?.skill ?? input.workspace?.skill ?? DEFAULT_VALIDATION_SKILL;
  return { strategy, skill };
}

/**
 * Normalize an action's `validate:` field (the union of string | object
 * form from `ValidateStrategySchema`) into the flat `{strategy, skill}`
 * shape `resolveValidation` consumes. Returns undefined when the action
 * doesn't set the field, so the helper falls through to job/workspace
 * defaults.
 *
 * Lives here rather than in fsm-engine so the merge call sites in
 * `case "llm"` / `case "agent"` can use one helper instead of inlining
 * the union narrowing twice.
 */
export function normalizeActionValidate(
  v:
    | "skip"
    | "self"
    | "external"
    | "auto"
    | { strategy: "self" | "external"; skill?: string }
    | undefined,
): { strategy?: "auto" | "skip" | "self" | "external"; skill?: string } | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string") return { strategy: v };
  return { strategy: v.strategy, ...(v.skill !== undefined ? { skill: v.skill } : {}) };
}

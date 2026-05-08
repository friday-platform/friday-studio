/**
 * Shared envelope used to thread the resolved validation decision from the
 * FSM engine's `case "agent"` site
 * through the workspace-runtime → orchestrator → agent-server boundary into
 * the LLM-prompt-assembly site (`convertLLMToAgent`).
 *
 * The cleanest channel that already crosses every layer is
 * `AgentContext.config: Record<string, unknown>`. We reserve a dedicated
 * key (`__atlas_validate`) so authors' `agents.<id>.config:` blocks can't
 * accidentally collide with — or shadow — the engine-injected decision.
 *
 * The helper here is intentionally tiny and synchronous: parse, default,
 * pass through. The actual prompt augmentation lives in
 * `composeValidationBlock`.
 */

/** Reserved key on `AgentContext.config` carrying the resolved validate decision. */
export const VALIDATE_DECISION_CONFIG_KEY = "__atlas_validate" as const;

/** Decoded shape stored under {@link VALIDATE_DECISION_CONFIG_KEY}. */
export interface ValidateDecisionContext {
  decision: "skip" | "self" | "external";
  /** Optional skill name override for the `self` path. */
  skill?: string;
  /**
   * Whether the action declares an `outputType:` resolving to a structured
   * schema. When `true` AND
   * `decision === "self"`, the orchestrator skips `record_validation`
   * tool injection — the structured schema IS the validation contract,
   * and injecting `record_validation` would force toolChoice off the
   * forced-complete pin that makes structured output reliable.
   */
  hasOutputType?: boolean;
}

/**
 * Read the engine-injected validate decision off `AgentContext.config`.
 * Returns `{ decision: "skip" }` when absent or malformed — i.e. defaults
 * to no validation augmentation, which preserves today's behavior for
 * callers that don't (yet) plumb the decision through.
 */
export function readValidateDecisionFromConfig(
  config: Record<string, unknown> | undefined,
): ValidateDecisionContext {
  if (!config) return { decision: "skip" };
  const raw = config[VALIDATE_DECISION_CONFIG_KEY];
  if (!raw || typeof raw !== "object") return { decision: "skip" };
  const obj = raw as Record<string, unknown>;
  const decision = obj.decision;
  if (decision !== "skip" && decision !== "self" && decision !== "external") {
    return { decision: "skip" };
  }
  const skill = typeof obj.skill === "string" ? obj.skill : undefined;
  const hasOutputType = obj.hasOutputType === true ? true : undefined;
  return { decision, ...(skill ? { skill } : {}), ...(hasOutputType ? { hasOutputType } : {}) };
}

/**
 * Build the value the FSM-engine→runtime adapter writes under
 * {@link VALIDATE_DECISION_CONFIG_KEY}. Wrapped as a helper so the
 * shape stays the single source of truth.
 */
export function buildValidateDecisionConfig(
  decision: "skip" | "self" | "external",
  skill?: string,
  hasOutputType?: boolean,
): Record<string, unknown> {
  const inner: Record<string, unknown> = { decision };
  if (skill) inner.skill = skill;
  if (hasOutputType) inner.hasOutputType = true;
  return { [VALIDATE_DECISION_CONFIG_KEY]: inner };
}

/**
 * Zod schemas for runtime validation of FSM definitions
 */

import { JSONSchemaSchema } from "@atlas/core/artifacts";
import { z } from "zod";

// Re-export from @atlas/core/artifacts for consistency
export { JSONSchemaSchema };

export const DocumentSchema = z.object({
  id: z.string(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
});

/**
 * Author-facing validation strategy for `type: llm` and `type: agent` actions.
 *
 * String form:
 *   - "skip"     — never validate; output is accepted as-is.
 *   - "self"     — inline validation in the same LLM call (B3 will inject a
 *                  `record_validation` tool + the validating-llm-outputs skill).
 *                  No-op until B3 lands; today behaves like "skip".
 *   - "external" — delegate spawn to a system-level judge agent
 *                  (`runJudge` callback, B7).
 *   - "auto"     — delegate to the runtime classifier (read-only/structured →
 *                  skip; mutating-tool/prose-emitting → self). Same as omitting
 *                  the field. The classifier never returns "external" — that
 *                  remains an explicit author opt-in.
 *
 * Object form (escape hatch for tuning a specific step without rewriting the
 * action shape): pin the `strategy` to `self` or `external` and optionally
 * override the validating skill or the judge agent. The object form
 * intentionally omits `skip` and `auto` — pick those via the string form.
 */
export const ValidateStrategySchema = z.union([
  z.literal("skip"),
  z.literal("self"),
  z.literal("external"),
  z.literal("auto"),
  z.strictObject({
    strategy: z.enum(["self", "external"]),
    skill: z.string().optional(),
    /**
     * Optional override for the `external` judge agent. B7 of
     * melodic-strolling-seal-pt2 — `external` is a delegate spawn to
     * `@friday/judge-agent` by default; authors can swap in a domain-
     * specific judge (e.g. `fin-judge` for finance pipelines) without
     * changing the runtime contract. Ignored when strategy is `"self"`.
     */
    agent: z.string().optional(),
  }),
]);

export const LLMActionSchema = z.object({
  type: z.literal("llm"),
  provider: z.string(),
  model: z.string(),
  prompt: z.string(),
  tools: z.array(z.string()).optional(),
  /**
   * Step-level skill allowlist. Narrows which skills this LLM action can
   * `load_skill`. Layered on top of the job/workspace skill scoping resolved
   * at the engine level.
   *
   * Semantics: empty array ⇒ no workspace skills for this step (load_skill
   * tool not registered); absent ⇒ inherit the job/workspace visibility
   * unchanged; populated ⇒ whitelist within the job's resolved set (skills
   * not in this list are dropped, even if they would otherwise be visible).
   */
  skills: z.array(z.string()).optional(),
  /**
   * Short human-readable summary of what this action does. Used as the
   * artifact title/summary when the action's `outputTo` document is
   * persisted as an artifact for compact return to a parent supervisor.
   * Absent → runtime synthesizes a short truncation from the output.
   */
  summary: z.string().optional(),
  /**
   * Per-action validation strategy. Absent or `"auto"` ⇒ runtime classifier
   * picks `skip` or `self` based on the action shape. See
   * `ValidateStrategySchema` for the full semantics. The classifier never
   * returns `external` — that remains an explicit author opt-in.
   */
  validate: ValidateStrategySchema.optional(),
  /**
   * K6 (melodic-strolling-seal-pt3) — `run_code` opt-in for read-only
   * classifier treatment. `run_code` is excluded from the default
   * `READ_ONLY_ALLOWLIST` because it can mutate state (write files, POST
   * over the network, etc.). When the author knows a particular invocation
   * is genuinely read-only — e.g. a one-shot SQL `SELECT`, a deterministic
   * HTTP `GET`, an arithmetic transform — setting `run_code: { readOnly:
   * true }` makes the classifier treat `run_code` as a read-only tool for
   * this action. Combined with structured `outputType:`, the action then
   * resolves to `validate: skip`.
   */
  run_code: z.strictObject({ readOnly: z.boolean() }).optional(),
  outputTo: z.string().optional(),
  /** Explicit document type name for schema lookup. Takes precedence over outputTo document's type. */
  outputType: z.string().optional(),
  /**
   * Document id(s) whose `data` becomes the LLM's task input. String form
   * chains a single prior step's `outputTo`; array form concatenates
   * multiple prior outputs labeled by id (`<id>: <data>` joined by blank
   * lines). The engine fails loud if any id is missing at action
   * execution time.
   */
  inputFrom: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
});

export const EmitActionSchema = z.object({
  type: z.literal("emit"),
  event: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const AgentActionSchema = z.object({
  type: z.literal("agent"),
  agentId: z.string(),
  outputTo: z.string().optional(),
  /** Explicit document type name for output schema lookup. Resolves to JSON Schema from documentTypes. */
  outputType: z.string().optional(),
  /** Per-step task instructions. Concatenated after the workspace agent's config prompt. */
  prompt: z.string().optional(),
  /** Step-level skill allowlist — see LLMActionSchema.skills for semantics. */
  skills: z.array(z.string()).optional(),
  /** Short human-readable summary — see LLMActionSchema.summary. */
  summary: z.string().optional(),
  /**
   * Per-action validation strategy — see `ValidateStrategySchema` for the
   * full semantics. Mirrors the field on LLMActionSchema so authors can
   * tune validation on agent invocations the same way.
   */
  validate: ValidateStrategySchema.optional(),
  /**
   * Document id(s) whose `data` becomes the agent's task input. String form
   * chains a single prior step's `outputTo`; array form concatenates
   * multiple prior outputs labeled by id (`<id>: <data>` joined by blank
   * lines). The engine fails loud if any id is missing at action
   * execution time.
   */
  inputFrom: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
});

export const NotificationActionSchema = z.object({
  type: z.literal("notification"),
  message: z.string(),
  /**
   * Optional allowlist of communicator kinds. Omitted = broadcast to every
   * configured communicator with a `default_destination`.
   */
  communicators: z.array(z.string()).optional(),
});

export const ActionSchema = z.discriminatedUnion("type", [
  LLMActionSchema,
  EmitActionSchema,
  AgentActionSchema,
  NotificationActionSchema,
]);

export const TransitionDefinitionSchema = z.object({
  target: z.string(),
  actions: z.array(ActionSchema).optional(),
});

export const StateDefinitionSchema = z.object({
  documents: z.array(DocumentSchema).optional(),
  entry: z.array(ActionSchema).optional(),
  on: z
    .record(z.string(), z.union([TransitionDefinitionSchema, z.array(TransitionDefinitionSchema)]))
    .optional(),
  type: z.literal("final").optional(),
});

export const FSMDefinitionSchema = z.object({
  id: z.string(),
  initial: z.string(),
  states: z.record(z.string(), StateDefinitionSchema),
  documentTypes: z.record(z.string(), JSONSchemaSchema).optional(),
  /**
   * Declarative-only — retained for back-compat with legacy YAML
   * (e.g. `packages/system/workspaces/workspace.fsm.yaml`) that still
   * declares a `functions:` block. Pt1 Phase 1 simplified the action
   * model: there is no `type: code` action anymore, so these function
   * bodies are never compiled or executed by `FSMEngine`. The validator
   * still checks each entry has non-empty code; `mcp-tools/create-fsm.ts`
   * counts them for telemetry. Treat as documentation, not behavior.
   */
  functions: z
    .record(z.string(), z.object({ type: z.enum(["action", "guard"]), code: z.string() }))
    .optional(),
  /**
   * Declarative-only — see `functions` above. FSM-level inline tools are
   * not registered with the LLM call site; the live tool surface is
   * resolved from MCP servers + platform tools, narrowed by each
   * `LLMAction.tools` allowlist. Retained for legacy YAML compatibility.
   */
  tools: z.record(z.string(), z.object({ code: z.string() })).optional(),
});

export const SignalSchema = z.object({
  type: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

// Export inferred types for use in implementation
export type ValidatedFSMDefinition = z.infer<typeof FSMDefinitionSchema>;
export type ValidatedStateDefinition = z.infer<typeof StateDefinitionSchema>;
export type ValidatedDocument = z.infer<typeof DocumentSchema>;
export type ValidatedAction = z.infer<typeof ActionSchema>;
export type ValidatedSignal = z.infer<typeof SignalSchema>;
export type ValidateStrategy = z.infer<typeof ValidateStrategySchema>;
export type { ValidatedJSONSchema } from "@atlas/core/artifacts";

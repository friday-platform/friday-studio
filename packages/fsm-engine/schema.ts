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
   * `run_code` advisory marker preserved for back-compat with workspaces
   * authored when this hint informed the (now-removed) validation
   * classifier. Currently a no-op — the runtime ignores the value.
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
export type { ValidatedJSONSchema } from "@atlas/core/artifacts";

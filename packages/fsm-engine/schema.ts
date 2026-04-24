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
   * @experimental — step-level skill filter. **Not enforced at runtime today.**
   * The additive job-scoping model (job-level `skills:` in workspace.yml)
   * covers the 95% case. This field is preserved for a future power-user
   * escape hatch to further narrow what a single FSM step can load, but
   * the engine currently ignores it.
   *
   * When reactivated, semantics would be: empty array ⇒ no workspace skills
   * for this step; absent ⇒ inherit job/workspace visibility; populated ⇒
   * whitelist within the job's resolved set.
   */
  skills: z.array(z.string()).optional(),
  outputTo: z.string().optional(),
  /** Explicit document type name for schema lookup. Takes precedence over outputTo document's type. */
  outputType: z.string().optional(),
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
  /** Task instructions for the agent. Takes precedence over agent config prompt. */
  prompt: z.string().optional(),
  /** @experimental — see LLMActionSchema.skills. Not enforced at runtime today. */
  skills: z.array(z.string()).optional(),
});

export const ActionSchema = z.discriminatedUnion("type", [
  LLMActionSchema,
  EmitActionSchema,
  AgentActionSchema,
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

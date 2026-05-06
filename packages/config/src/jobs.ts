/**
 * Job specification schemas
 */

import { z } from "zod";
import {
  AllowDenyFilterSchema,
  ConditionSchema,
  DurationSchema,
  // ErrorConfigSchema,  // Currently unused
  ExecutionStrategy,
  MCPToolNameSchema,
  SchemaObjectSchema,
  // SuccessConfigSchema,  // Currently unused
  SupervisionLevel,
} from "./base.ts";
import { DelegationBudgetSchema } from "./delegation.ts";
import { PermissionsConfigSchema } from "./permissions.ts";
import { SkillRefSchema } from "./skills.ts";
import { ValidationDefaultsSchema } from "./validation.ts";

// ==============================================================================
// TRIGGER SPECIFICATION
// ==============================================================================

export const TriggerSpecificationSchema = z.strictObject({
  signal: z.string().describe("Signal name that triggers this job"),
  condition: ConditionSchema.optional().describe("Condition for triggering"),
});
export type TriggerSpecification = z.infer<typeof TriggerSpecificationSchema>;

// ==============================================================================
// FILE CONTEXT
// ==============================================================================

export const FileContextSchema = z.strictObject({
  patterns: z.array(z.string()).describe("Glob patterns for files (supports exclusions with !)"),
  base_path: z.string().optional(),
  max_file_size: z.number().int().positive().optional(),
  include_content: z.boolean().optional().default(true),
});
export type FileContext = z.infer<typeof FileContextSchema>;

// ==============================================================================
// AGENT CONTEXT
// ==============================================================================

export const AgentContextSchema = z.strictObject({
  signal: z.boolean().optional().describe("Include signal data"),
  steps: z.enum(["previous", "all"]).optional().describe("Include step outputs"),
  agents: z.array(z.string()).optional().describe("Specific agent outputs to include"),
  files: z.boolean().optional().describe("Include filesystem context"),
  task: z.string().optional().describe("Additional task description appended to prompt"),
});
export type AgentContext = z.infer<typeof AgentContextSchema>;

// ==============================================================================
// JOB EXECUTION AGENT
// ==============================================================================

const JobExecutionAgentSimpleSchema = z.string().describe("Simple agent ID reference");

const JobExecutionAgentDetailedSchema = z.strictObject({
  id: z.string().describe("Agent ID"),
  nickname: z.string().optional().describe("Optional nickname for reference"),
  context: AgentContextSchema.optional(),
  dependencies: z.array(z.string()).optional().describe("Explicit agent dependencies"),
  tools: AllowDenyFilterSchema.optional().describe("Tool access override for this agent"),
});

export const JobExecutionAgentSchema = z.union([
  JobExecutionAgentSimpleSchema,
  JobExecutionAgentDetailedSchema,
]);
export type JobExecutionAgent = z.infer<typeof JobExecutionAgentSchema>;

// ==============================================================================
// JOB EXECUTION
// ==============================================================================

export const JobExecutionSchema = z.strictObject({
  strategy: ExecutionStrategy.default("sequential"),
  agents: z.array(JobExecutionAgentSchema).min(1).describe("Agent pipeline"),
  context: z
    .strictObject({ files: FileContextSchema.optional() })
    .optional()
    .describe("Execution-level context"),
});
export type JobExecution = z.infer<typeof JobExecutionSchema>;

// ==============================================================================
// JOB CONFIGURATION
// ==============================================================================

// JobConfigSchema — typed fields validate strictly, but user-defined
// per-job config keys (e.g. targetWorkspaceId for a review job,
// notesMemory for an inbox job) are passed through unmodified via
// .loose(). The job's entrypoint reads them via context.config.<key>.
// .strictObject() rejects extras; .looseObject() preserves them.
export const JobConfigSchema = z.looseObject({
  timeout: DurationSchema.optional(),
  max_steps: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("Max LLM tool-calling steps for FSM actions (default: 10)"),
  supervision: z
    .strictObject({
      level: SupervisionLevel.optional(),
      skip_planning: z.boolean().optional().describe("Skip planning phase for simple jobs"),
    })
    .optional(),
});
export type JobConfig = z.infer<typeof JobConfigSchema>;

// ==============================================================================
// JOB SPECIFICATION
// ==============================================================================

export const JobSpecificationSchema = z
  .strictObject({
    name: MCPToolNameSchema.optional().describe("MCP-compliant job name"),
    description: z.string().optional(),
    entrypoint: z
      .string()
      .optional()
      .describe(
        "Optional TypeScript entry point file for FSM-based jobs that ship their own .ts implementation. Relative to the workspace root.",
      ),
    title: z
      .string()
      .optional()
      .describe("Short human-readable title (2-4 words, e.g., 'Daily Summary')"),

    // Triggers
    triggers: z.array(TriggerSpecificationSchema).optional(),

    // Context configuration
    context: z
      .strictObject({ files: FileContextSchema.optional().describe("Job-level file context") })
      .optional(),

    // Prompt for supervisor guidance
    prompt: z.string().optional().describe("Single prompt string for supervisor"),

    // Input schema for job invocation (exposed as tool parameters in workspace chat)
    inputs: SchemaObjectSchema.optional().describe(
      "JSON Schema for job inputs, exposed as tool parameters in workspace chat",
    ),

    // Job-level skill assignments (additive to workspace-level skills).
    // DECLARATIVE only in v1 — no YAML-reconcile hook today. Setting this
    // in workspace.yml warns at parse time if no matching skill_assignments
    // row exists in the DB. Use the scoping API (UI / CLI) to create
    // actual assignments. `@friday/*` is always available regardless of
    // this list.
    skills: z
      .array(SkillRefSchema)
      .optional()
      .describe(
        "Declarative intent: skills this job should have access to in " +
          "addition to workspace-level skills. Not auto-applied — use the " +
          "scoping API to create assignments.",
      ),

    // Execution - either agent-based or FSM-based
    execution: JobExecutionSchema.optional().describe("Agent-based execution pipeline"),
    fsm: z
      .any()
      .optional()
      .describe(
        "FSM-based workflow definition. See @atlas/fsm-engine for FSMDefinition structure.",
      ),

    // Terminal states
    success: z
      .strictObject({
        condition: ConditionSchema,
        schema: SchemaObjectSchema.optional().describe("Structured output schema"),
      })
      .optional(),

    error: z.strictObject({ condition: ConditionSchema }).optional(),

    // Job configuration
    config: JobConfigSchema.optional(),

    // Per-job permissions override. When omitted, inherits the workspace-level
    // setting (then the daemon FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS env var
    // as the floor). Jobs are the execution sandbox abstraction, so per-job
    // is the natural granularity for `dangerouslySkipAllowlist`.
    permissions: PermissionsConfigSchema.optional(),

    /**
     * Phase 8 — per-job delegation budget override. Per-field merge with
     * the workspace-level `delegation:` block: job wins per-field over
     * workspace; unset fields fall through to workspace then to runtime
     * defaults. Bounds the `delegate` tool invocations spawned from this
     * job's `type: llm` actions.
     */
    delegation: DelegationBudgetSchema.optional(),

    /**
     * Phase B5 — per-job validation policy override. Per-field merge
     * with the workspace-level `validation:` block: job wins per field
     * over workspace; unset fields fall through. Action-level
     * `validate:` always wins over both.
     */
    validation: ValidationDefaultsSchema.optional(),

    /**
     * Phase 6 — per-job artifact lifecycle override. When set, every
     * non-plumbing FSM document this job emits gets the matching
     * `lifecycle.kind`. Without an override, the runtime falls back to
     * the per-action default (terminal-state outputs durable;
     * non-terminal outputs ephemeral, bound to session).
     */
    artifacts: z
      .strictObject({
        ephemeral: z
          .boolean()
          .optional()
          .describe(
            "true → all artifacts ephemeral (session-bound). false → all durable. " +
              "Omit for per-action defaults.",
          ),
        default_grace: DurationSchema.optional().describe(
          "Grace window after job completion before ephemeral artifacts are " +
            "swept (Phase 6.B). Inherits from workspace.artifacts.default_grace " +
            "when omitted; that defaults to '24h'.",
        ),
      })
      .optional(),

    // Memory output declaration — where a job's findings are written
    outputs: z.object({ memory: z.string(), entryKind: z.string() }).optional(),

    // Improvement key convention — which YAML path the downstream applier reads
    improvement_key_convention: z.object({ scoped: z.string(), default: z.string() }).optional(),

    // Classes of changes the job is NOT allowed to propose findings about
    scope_exclusions: z.array(z.string()).optional(),

    // Per-job improvement policy override (absent = inherit from workspace level)
    improvement: z.enum(["surface", "auto"]).optional(),
  })
  .refine(
    (data) => {
      // Exactly one of execution or fsm must be provided
      const hasExecution = data.execution !== undefined;
      const hasFsm = data.fsm !== undefined;
      return (hasExecution && !hasFsm) || (!hasExecution && hasFsm);
    },
    { message: "Job must specify exactly one of: execution (agent-based) or fsm (FSM-based)" },
  );

export type JobSpecification = z.infer<typeof JobSpecificationSchema>;

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
import { SkillRefSchema } from "./skills.ts";

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
// CONCURRENCY POLICY
// ==============================================================================

/**
 * Concurrency policy for a job. Controls what happens when N triggers for the
 * same job arrive at once.
 *
 * - `concurrent` (default): every trigger fans out independently. Right for
 *   chat, NATS event processing, independent work units.
 * - `serialize`: at most one running; new triggers queue. Use `max_queued`
 *   to bound the queue. Right for sequential-event jobs like
 *   "process orders in arrival order".
 * - `skip-if-running`: new trigger drops if one is already running. Right for
 *   periodic sweeps where overlap is wasteful but missing a tick is fine.
 * - `coalesce`: newer trigger replaces queued one; one execution catches up.
 *   Right for cron catch-up after downtime, burst-deduplication on noisy
 *   NATS subjects.
 * - `singleton`: at most one across all daemon replicas (cross-process
 *   advisory lock). Right for external single-writer constraints.
 */
export const ConcurrencyPolicySchema = z.strictObject({
  policy: z
    .enum(["concurrent", "serialize", "skip-if-running", "coalesce", "singleton"])
    .default("concurrent"),
  max_queued: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Maximum number of pending triggers when policy=serialize. Beyond this, new triggers are dropped.",
    ),
});

export type ConcurrencyPolicy = z.infer<typeof ConcurrencyPolicySchema>;

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

    // Memory output declaration — where a job's findings are written
    outputs: z.object({ memory: z.string(), entryKind: z.string() }).optional(),

    // Improvement key convention — which YAML path the downstream applier reads
    improvement_key_convention: z.object({ scoped: z.string(), default: z.string() }).optional(),

    // Classes of changes the job is NOT allowed to propose findings about
    scope_exclusions: z.array(z.string()).optional(),

    // Per-job improvement policy override (absent = inherit from workspace level)
    improvement: z.enum(["surface", "auto"]).optional(),

    // Concurrency policy. Default is `concurrent` — every trigger fans out
    // independently. See plans/2026-05-01-stateless-friday.md G2.2.
    concurrency: ConcurrencyPolicySchema.optional(),
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

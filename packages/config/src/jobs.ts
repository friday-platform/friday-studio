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

export const JobConfigSchema = z.strictObject({
  timeout: DurationSchema.optional(),
  supervision: z
    .strictObject({
      level: SupervisionLevel.optional(),
      skip_planning: z.boolean().optional().describe("Skip planning phase for simple jobs"),
    })
    .optional(),
  memory: z
    .strictObject({
      enabled: z.boolean().optional().default(true),
      fact_extraction: z.boolean().optional().default(true),
      summary: z.boolean().optional().default(true).describe("Include summary in session receipt"),
    })
    .optional(),
});
export type JobConfig = z.infer<typeof JobConfigSchema>;

// ==============================================================================
// JOB SPECIFICATION
// ==============================================================================

export const JobSpecificationSchema = z.strictObject({
  name: MCPToolNameSchema.optional().describe("MCP-compliant job name"),
  description: z.string().optional(),

  // Triggers
  triggers: z.array(TriggerSpecificationSchema).optional(),

  // Context configuration
  context: z
    .strictObject({ files: FileContextSchema.optional().describe("Job-level file context") })
    .optional(),

  // Prompt for supervisor guidance
  prompt: z.string().optional().describe("Single prompt string for supervisor"),

  // Execution
  execution: JobExecutionSchema,

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
});

export type JobSpecification = z.infer<typeof JobSpecificationSchema>;

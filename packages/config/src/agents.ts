/**
 * Agent configuration schemas with tagged unions
 */

import { AtlasAgentConfigSchema } from "@atlas/agent-sdk";
import { z } from "zod/v4";
import {
  DurationSchema,
  ErrorConfigSchema,
  SchemaObjectSchema,
  SuccessConfigSchema,
} from "./base.ts";
import { MCPAuthConfigSchema } from "./mcp.ts";

// ==============================================================================
// BASE AGENT SCHEMA
// ==============================================================================

const BaseAgentConfigSchema = z.strictObject({
  description: z.string().describe("Agent purpose/description"),
});

// ==============================================================================
// LLM AGENT
// ==============================================================================

const LLMToolChoiceSchema = z.union([z.literal("auto"), z.literal("required"), z.literal("none")]);

export const LLMAgentConfigSchema = BaseAgentConfigSchema.extend({
  type: z.literal("llm"),
  config: z.strictObject({
    // Provider and model
    provider: z.enum(["anthropic", "openai", "google"]),
    model: z.string().describe("Model identifier (e.g., 'claude-3-7-sonnet-latest')"),

    // Single prompt string
    prompt: z.string().describe("System prompt for the agent"),

    // LLM parameters
    temperature: z.coerce
      .number()
      .min(0)
      .max(0.7)
      .optional()
      .default(0.3)
      .describe("Temperature (0-0.7 range)"),
    max_tokens: z.coerce.number().int().positive().optional(),
    max_steps: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max steps for multi-step tool calling"),

    // Tool configuration
    tool_choice: LLMToolChoiceSchema.optional(),
    tools: z.array(z.string()).optional().describe("Available tools (simple array)"),

    // Provider-specific options
    provider_options: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Provider-specific options passed directly to the LLM SDK"),

    // Success/error handlers
    success: SuccessConfigSchema.optional(),
    error: ErrorConfigSchema.optional(),

    // Error handling
    max_retries: z.coerce.number().int().min(0).optional(),
    timeout: DurationSchema.optional(),
  }),
});

// ==============================================================================
// SYSTEM AGENT
// ==============================================================================

// Specific schema based on conversation agent usage
const SystemAgentConfigObjectSchema = z
  .strictObject({
    // LLM Configuration
    model: z.string().optional().describe("LLM model to use"),
    temperature: z.coerce
      .number()
      .min(0)
      .max(1)
      .optional()
      .default(0.3)
      .describe("LLM temperature"),
    max_tokens: z.coerce.number().min(1).optional().describe("Maximum tokens for LLM response"),

    // Tools Configuration
    tools: z.array(z.string()).optional().describe("Array of tool names available to the agent"),

    // Reasoning Configuration
    use_reasoning: z.boolean().optional().describe("Enable reasoning capabilities"),
    max_reasoning_steps: z.coerce
      .number()
      .min(1)
      .max(20)
      .optional()
      .describe("Maximum reasoning steps"),

    // Prompt Configuration
    prompt: z.string().describe("System prompt for the agent").optional(),
  })
  .describe("System agent configuration");

const SystemAgentConfigSchema = BaseAgentConfigSchema.extend({
  type: z.literal("system"),
  agent: z.string().describe("System agent identifier"),
  config: SystemAgentConfigObjectSchema.optional(),
});

// ==============================================================================
// REMOTE AGENT
// ==============================================================================

const RemoteAgentConfigSchema = BaseAgentConfigSchema.extend({
  type: z.literal("remote"),
  config: z.strictObject({
    // Only ACP protocol is currently supported
    protocol: z.literal("acp"),
    endpoint: z.url(),

    // ACP-specific config (flattened since protocol is fixed)
    agent_name: z
      .string()
      .regex(/^[a-z0-9-]+$/, { message: "Agent name must be lowercase with hyphens" }),
    default_mode: z.enum(["sync", "async", "stream"]).default("async"),
    health_check_interval: DurationSchema.default("30s"),

    // Common remote config
    auth: MCPAuthConfigSchema.optional(),
    timeout: DurationSchema.optional(),
    max_retries: z.coerce.number().int().min(0).default(2),

    // Prompt configuration
    prompt: z.string().describe("System prompt for the agent").optional(),

    // Schema validation
    schema: z
      .strictObject({
        validate_input: z.boolean().default(false),
        validate_output: z.boolean().default(false),
        input: SchemaObjectSchema.optional(),
        output: SchemaObjectSchema.optional(),
      })
      .optional(),

    // Success/error handlers
    success: SuccessConfigSchema.optional(),
    error: ErrorConfigSchema.optional(),
  }),
});

// ==============================================================================
// DISCRIMINATED UNION
// ==============================================================================

/**
 * Agent configuration with tagged union on type
 */
export const WorkspaceAgentConfigSchema = z.discriminatedUnion("type", [
  LLMAgentConfigSchema,
  SystemAgentConfigSchema,
  RemoteAgentConfigSchema,
  AtlasAgentConfigSchema,
]);

export type WorkspaceAgentConfig = z.infer<typeof WorkspaceAgentConfigSchema>;

// Export schemas for runtime validation
export { SystemAgentConfigObjectSchema };

// Type guards for agent types
export type LLMAgentConfig = z.infer<typeof LLMAgentConfigSchema>;
export type SystemAgentConfig = z.infer<typeof SystemAgentConfigSchema>;
export type SystemAgentConfigObject = z.infer<typeof SystemAgentConfigObjectSchema>;
export type RemoteAgentConfig = z.infer<typeof RemoteAgentConfigSchema>;

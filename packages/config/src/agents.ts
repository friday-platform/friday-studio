/**
 * Agent configuration schemas with tagged unions
 */

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

const LLMToolChoiceSchema = z.union([
  z.literal("auto"),
  z.literal("required"),
  z.literal("none"),
]);

const LLMAgentConfigSchema = BaseAgentConfigSchema.extend({
  type: z.literal("llm"),
  config: z.strictObject({
    // Provider and model
    provider: z.enum(["anthropic", "openai", "google"]).default("anthropic"),
    model: z.string().describe("Model identifier (e.g., 'claude-3-5-sonnet-20241022')"),

    // Single prompt string
    prompt: z.string().describe("System prompt for the agent"),

    // LLM parameters
    temperature: z.number().min(0).max(1).optional().describe("Temperature (0-1 range)"),
    max_tokens: z.number().int().positive().optional(),
    max_steps: z.number().int().positive().optional().describe(
      "Max steps for multi-step tool calling",
    ),

    // Tool configuration
    tool_choice: LLMToolChoiceSchema.optional(),
    tools: z.array(z.string()).optional().describe("Available tools (simple array)"),

    // Success/error handlers
    success: SuccessConfigSchema.optional(),
    error: ErrorConfigSchema.optional(),

    // Error handling
    max_retries: z.number().int().min(0).optional(),
    timeout: DurationSchema.optional(),
  }),
});

// ==============================================================================
// SYSTEM AGENT
// ==============================================================================

// Specific schema based on conversation agent usage
const SystemAgentConfigObjectSchema = z.strictObject({
  // LLM Configuration
  model: z.string().optional().describe("LLM model to use"),
  temperature: z.number().min(0).max(2).optional().describe("LLM temperature"),
  max_tokens: z.number().min(1).optional().describe("Maximum tokens for LLM response"),

  // Tools Configuration
  tools: z.array(z.string()).optional().describe("Array of tool names available to the agent"),

  // Reasoning Configuration
  use_reasoning: z.boolean().optional().describe("Enable reasoning capabilities"),
  max_reasoning_steps: z.number().min(1).max(20).optional().describe("Maximum reasoning steps"),

  // Prompt Configuration
  prompt: z.string().describe("System prompt for the agent").optional(),
}).describe("System agent configuration");

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
    agent_name: z.string().regex(/^[a-z0-9-]+$/, {
      message: "Agent name must be lowercase with hyphens",
    }),
    default_mode: z.enum(["sync", "async", "stream"]).default("async"),
    health_check_interval: DurationSchema.default("30s"),

    // Common remote config
    auth: MCPAuthConfigSchema.optional(),
    timeout: DurationSchema.optional(),
    max_retries: z.number().int().min(0).default(2),

    // Prompt configuration
    prompt: z.string().describe("System prompt for the agent").optional(),

    // Schema validation
    schema: z.strictObject({
      validate_input: z.boolean().default(false),
      validate_output: z.boolean().default(false),
      input: SchemaObjectSchema.optional(),
      output: SchemaObjectSchema.optional(),
    }).optional(),

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
]);

export type WorkspaceAgentConfig = z.infer<typeof WorkspaceAgentConfigSchema>;

// Export schemas for runtime validation
export { SystemAgentConfigObjectSchema };

// Type guards for agent types
export type LLMAgentConfig = z.infer<typeof LLMAgentConfigSchema>;
export type SystemAgentConfig = z.infer<typeof SystemAgentConfigSchema>;
export type SystemAgentConfigObject = z.infer<typeof SystemAgentConfigObjectSchema>;
export type RemoteAgentConfig = z.infer<typeof RemoteAgentConfigSchema>;

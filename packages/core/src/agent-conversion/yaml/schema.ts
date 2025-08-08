/**
 * YAML Agent Schema Definitions
 *
 * Zod schemas and TypeScript types for .agent.yml validation.
 * Defines the complete structure and validation rules for YAML agent files.
 */

import { z } from "zod/v4";
import {
  type AgentEnvironmentConfig,
  AgentEnvironmentConfigSchema,
  AgentMetadataSchema,
} from "@atlas/agent-sdk";
import { MCPServerConfigSchema } from "@atlas/config";

/** MCP server config with tool filtering and auth options. */
export const YAMLMCPServerConfigSchema = MCPServerConfigSchema.omit({
  auth: true,
  tools: true,
}).extend({
  /** Authentication configuration */
  auth: z.object({
    type: z.enum(["bearer", "api_key", "basic"]),
    header: z.string().optional().describe("Header name for the token"),
    token_env: z.string().optional().describe("Environment variable containing the token"),
    username_env: z.string().optional().describe("Environment variable containing username"),
    password_env: z.string().optional().describe("Environment variable containing password"),
  }).optional(),

  /** Tool configuration */
  tools: z.object({
    /** Allow specific tools only */
    allow: z.array(z.string()).optional().describe("List of allowed tool names"),
    /** Deny specific tools */
    deny: z.array(z.string()).optional().describe("List of denied tool names"),
  }).optional(),
});

export type YAMLMCPServerConfig = z.infer<typeof YAMLMCPServerConfigSchema>;

/** LLM configuration schema for YAML agents. */
export const YAMLLLMConfigSchema = z.object({
  provider: z.enum(["anthropic", "openai", "google"], {
    message: "Provider must be 'anthropic', 'openai', or 'google'",
  }).describe("LLM provider to use"),

  model: z.string().min(1, {
    message: "Model is required for YAML agents",
  }).describe("Specific model to use (e.g., 'claude-3-5-sonnet-20241022')"),

  prompt: z.string().min(1, {
    message: "System prompt is required for YAML agents",
  }).describe("System prompt that defines agent behavior"),

  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().positive().optional(),
  max_steps: z.number().positive().default(10).optional(),
  timeout: z.object({
    progressTimeout: z.string().regex(/^\d+[smh]$/, {
      message: "Duration must be in format like '30s', '2m', or '1h'",
    }).default("30s").optional(),
    maxTotalTimeout: z.string().regex(/^\d+[smh]$/, {
      message: "Duration must be in format like '30s', '2m', or '1h'",
    }).default("5m").optional(),
  }).optional(),

  streaming: z.object({
    enabled: z.boolean().default(true),
    chunk_size: z.number().optional(),
  }).optional(),

  tool_choice: z.enum(["auto", "required", "none"]).default("auto").optional(),

  provider_options: z.record(z.string(), z.unknown()).optional().describe(
    "Provider-specific configuration (e.g., anthropic.thinking, openai.logitBias)",
  ),
});

export type YAMLLLMConfig = z.infer<typeof YAMLLLMConfigSchema>;

/** Top-level schema for .agent.yml files. */
export const YAMLAgentSchema = z.object({
  agent: AgentMetadataSchema,
  environment: AgentEnvironmentConfigSchema.optional(),
  mcp_servers: z.record(z.string(), YAMLMCPServerConfigSchema).optional(),
  llm: YAMLLLMConfigSchema,
});

export type YAMLAgentDefinition = z.infer<typeof YAMLAgentSchema>;

/** Export simplified JSON Schema for external tooling. */
export function exportJSONSchema() {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Atlas YAML Agent Definition",
    description: "Schema for Atlas agent YAML configuration files",
    type: "object",
    required: ["agent", "llm"],
    properties: {
      agent: {
        type: "object",
        description: "Agent metadata and expertise",
        required: ["name", "version", "description", "expertise"],
      },
      environment: {
        type: "object",
        description: "Environment variables configuration",
      },
      mcp_servers: {
        type: "object",
        description: "MCP server configurations",
        additionalProperties: true,
      },
      llm: {
        type: "object",
        description: "LLM configuration",
        required: ["prompt"],
      },
    },
  };
}

/** Validate and parse YAML agent data using schema. */
export function validateYAMLAgent(data: unknown): YAMLAgentDefinition {
  try {
    return YAMLAgentSchema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(`Invalid YAML agent configuration:\n${z.prettifyError(error)}`);
    }
    throw error;
  }
}

/** Type guard for YAML agent definition validation. */
export function isYAMLAgentDefinition(data: unknown): data is YAMLAgentDefinition {
  return YAMLAgentSchema.safeParse(data).success;
}

/** Default YAML agent configuration template. */
export const DEFAULT_YAML_AGENT: Partial<YAMLAgentDefinition> = {
  agent: {
    id: "my-agent",
    version: "1.0.0",
    description: "My domain expert agent",
    expertise: {
      domains: ["my-domain"],
      capabilities: ["capability-1", "capability-2"],
      examples: ["example prompt 1", "example prompt 2"],
    },
  },
  llm: {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    temperature: 0.3,
    max_tokens: 2000,
    prompt: "You are a domain expert. Help users with tasks in your domain.",
  },
};

/** Merge agent and workspace environment variables with agent precedence. */
export function mergeEnvironmentConfig(
  agentEnv?: AgentEnvironmentConfig,
  workspaceEnv?: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = { ...workspaceEnv };

  if (agentEnv?.optional) {
    for (const envVar of agentEnv.optional) {
      if (envVar.default && !result[envVar.name]) {
        result[envVar.name] = envVar.default;
      }
    }
  }

  return result;
}

/** Validate required environment variables against agent config. */
export function validateEnvironment(
  config: AgentEnvironmentConfig | undefined,
  provided: Record<string, string>,
): void {
  if (!config?.required) return;

  const errors: string[] = [];

  for (const requirement of config.required) {
    const value = provided[requirement.name];

    if (!value) {
      errors.push(`Missing required environment variable: ${requirement.name}`);
      continue;
    }

    if (requirement.validation) {
      const regex = new RegExp(requirement.validation);
      if (!regex.test(value)) {
        errors.push(
          `Invalid value for ${requirement.name}: does not match pattern ${requirement.validation}`,
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Environment validation failed:\n${errors.join("\n")}`);
  }
}

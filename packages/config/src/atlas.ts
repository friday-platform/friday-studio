/**
 * Atlas-specific configuration schemas
 * These are only available in atlas.yml, not workspace.yml
 */

import { z } from "zod/v4";
import { DurationSchema, SupervisionLevel } from "./base.ts";

// ==============================================================================
// SUPERVISOR CONFIGURATION
// ==============================================================================

const SupervisorPromptsSchema = z.strictObject({
  system: z.string().optional(),
  analysis: z.string().optional(),
  planning: z.string().optional(),
});
export type SupervisorPrompts = z.infer<typeof SupervisorPromptsSchema>;

const SupervisorConfigSchema = z.strictObject({
  model: z.string().describe("LLM model to use for supervision"),
  memory: z.string().optional().describe("Memory scope to use"),

  supervision: z.strictObject({
    level: SupervisionLevel,
    cache_enabled: z.boolean(),
    cache_adapter: z.string().optional(),
    cache_ttl_hours: z.number().positive().optional(),
    parallel_llm_calls: z.boolean().optional(),
    timeouts: z.strictObject({
      analysis: DurationSchema,
      validation: DurationSchema,
      execution: DurationSchema.optional(),
    }).optional(),
  }),

  prompts: SupervisorPromptsSchema,
});
export type SupervisorConfig = z.infer<typeof SupervisorConfigSchema>;

export const SupervisorsConfigSchema = z.strictObject({
  workspace: SupervisorConfigSchema,
  session: SupervisorConfigSchema,
  agent: SupervisorConfigSchema,
});
export type SupervisorsConfig = z.infer<typeof SupervisorsConfigSchema>;

// ==============================================================================
// PLANNING CONFIGURATION
// ==============================================================================

const PrecomputationLevel = z.enum(["aggressive", "moderate", "minimal", "disabled"]);
type PrecomputationLevel = z.infer<typeof PrecomputationLevel>;

export const PlanningConfigSchema = z.strictObject({
  execution: z.strictObject({
    precomputation: PrecomputationLevel,
    cache_enabled: z.boolean(),
    cache_ttl_hours: z.number().positive(),
    invalidate_on_job_change: z.boolean(),

    strategy_selection: z.strictObject({
      simple_jobs: z.string(),
      complex_jobs: z.string(),
      optimization_jobs: z.string(),
      planning_jobs: z.string(),
    }),

    strategy_thresholds: z.strictObject({
      complexity: z.number().min(0).max(1),
      uncertainty: z.number().min(0).max(1),
      optimization: z.number().min(0).max(1),
    }),
  }),

  validation: z.strictObject({
    precomputation: PrecomputationLevel,
    functional_validators: z.boolean(),
    smoke_tests: z.boolean(),
    content_safety: z.boolean(),
    llm_threshold: z.number().min(0).max(1),
    llm_fallback: z.boolean(),
    cache_enabled: z.boolean(),
    cache_ttl_hours: z.number().positive(),
    fail_fast: z.boolean(),

    external_services: z.strictObject({
      openai_moderation: z.boolean(),
      perspective_api: z.boolean(),
      deepeval_service: z.string().nullable(),
    }).optional(),
  }),
});
export type PlanningConfig = z.infer<typeof PlanningConfigSchema>;

// ==============================================================================
// RUNTIME CONFIGURATION
// ==============================================================================

export const RuntimeConfigSchema = z.strictObject({
  server: z.strictObject({
    port: z.number().int().min(1).max(65535),
    host: z.string(),
  }).optional(),

  logging: z.strictObject({
    level: z.enum(["debug", "info", "warn", "error"]),
    format: z.enum(["json", "pretty"]),
  }).optional(),

  persistence: z.strictObject({
    type: z.enum(["local", "memory", "s3", "gcs", "azure"]),
    path: z.string(),
  }).optional(),

  security: z.strictObject({
    cors: z.string(),
  }).optional(),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

// ==============================================================================
// SYSTEM WORKSPACES
// ==============================================================================

export const SystemWorkspaceConfigSchema = z.strictObject({
  enabled: z.boolean(),
  workspace_path: z.string(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type SystemWorkspaceConfig = z.infer<typeof SystemWorkspaceConfigSchema>;

// ==============================================================================
// SERVER CONFIGURATION
// ==============================================================================

import { AtlasPlatformMCPConfigSchema, PlatformMCPConfigSchema } from "./mcp.ts";

/**
 * Basic server configuration (workspace.yml)
 */
export const ServerConfigSchema = z.strictObject({
  mcp: PlatformMCPConfigSchema.optional().describe("Atlas exposing itself as MCP server"),
});
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/**
 * Extended server configuration (atlas.yml only)
 */
export const AtlasServerConfigSchema = ServerConfigSchema.extend({
  mcp: AtlasPlatformMCPConfigSchema.optional(),
  rest: z.strictObject({
    enabled: z.boolean().default(false),
    prefix: z.string().default("/api/v1"),
    swagger: z.boolean().default(false),
  }).optional().describe("REST API configuration (not currently implemented)"),
});
export type AtlasServerConfig = z.infer<typeof AtlasServerConfigSchema>;

/**
 * Atlas-specific configuration schemas
 * These are only available in atlas.yml, not workspace.yml
 */

import { z } from "zod";
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

  supervision: z.strictObject({
    level: SupervisionLevel,
    cache_enabled: z.boolean(),
    cache_adapter: z.string().optional(),
    cache_ttl_hours: z.number().positive().optional(),
    parallel_llm_calls: z.boolean().optional(),
    timeouts: z
      .strictObject({
        analysis: DurationSchema,
        validation: DurationSchema,
        execution: DurationSchema.optional(),
      })
      .optional(),
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
  rest: z
    .strictObject({
      enabled: z.boolean().default(false),
      prefix: z.string().default("/api/v1"),
      swagger: z.boolean().default(false),
    })
    .optional()
    .describe("REST API configuration (not currently implemented)"),
});
export type AtlasServerConfig = z.infer<typeof AtlasServerConfigSchema>;

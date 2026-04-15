/**
 * Atlas-specific configuration schemas
 * These are only available in friday.yml, not workspace.yml
 */

import { z } from "zod";

// ==============================================================================
// PLATFORM MODELS CONFIGURATION
// ==============================================================================

const ModelIdSchema = z
  .string()
  .regex(/^[a-z-]+:.+$/, "Must be in 'provider:model' format (e.g., 'anthropic:claude-haiku-4-5')");

/**
 * Per-archetype model selection for platform LLM calls.
 * Any omitted field falls back to the built-in default chain.
 */
export const PlatformModelsSchema = z.object({
  labels: ModelIdSchema.optional(),
  classifier: ModelIdSchema.optional(),
  planner: ModelIdSchema.optional(),
  conversational: ModelIdSchema.optional(),
});
export type PlatformModelsConfig = z.infer<typeof PlatformModelsSchema>;

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
 * Extended server configuration (friday.yml only)
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

/**
 * Main workspace configuration schemas
 */

import { z } from "zod/v4";
import { FederationConfigSchema, MCPToolNameSchema, WorkspaceIdentitySchema } from "./base.ts";
import {
  AtlasServerConfigSchema,
  PlanningConfigSchema,
  RuntimeConfigSchema,
  ServerConfigSchema,
  SupervisorsConfigSchema,
} from "./atlas.ts";
import { AtlasToolsConfigSchema, ToolsConfigSchema } from "./mcp.ts";
import { WorkspaceSignalConfigSchema } from "./signals.ts";
import { WorkspaceAgentConfigSchema } from "./agents.ts";
import { JobSpecificationSchema } from "./jobs.ts";
import { AtlasMemoryConfigSchema, WorkspaceMemoryConfigSchema } from "./memory.ts";

// ==============================================================================
// WORKSPACE CONFIGURATION (workspace.yml)
// ==============================================================================

export const WorkspaceConfigSchema = z.strictObject({
  // Required version
  version: z.literal("1.0").describe("Configuration version (currently '1.0')"),

  // Workspace identity
  workspace: WorkspaceIdentitySchema,

  // Server configuration (how workspace exposes itself)
  server: ServerConfigSchema.optional(),

  // Tools configuration (external MCP servers agents can call)
  tools: ToolsConfigSchema.optional(),

  // Business logic
  signals: z.record(z.string(), WorkspaceSignalConfigSchema).optional(),
  jobs: z.record(MCPToolNameSchema, JobSpecificationSchema).optional(),
  agents: z.record(z.string(), WorkspaceAgentConfigSchema).optional(),

  // Memory configuration
  memory: WorkspaceMemoryConfigSchema.optional(),

  // Federation
  federation: FederationConfigSchema.optional(),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

// ==============================================================================
// ATLAS CONFIGURATION (atlas.yml - superset of workspace.yml)
// ==============================================================================

export const AtlasConfigSchema = WorkspaceConfigSchema.extend({
  // Override with extended versions
  server: AtlasServerConfigSchema.optional(),
  tools: AtlasToolsConfigSchema.optional(),
  memory: AtlasMemoryConfigSchema.optional(),

  // Atlas-specific additions
  supervisors: SupervisorsConfigSchema.optional(),
  planning: PlanningConfigSchema.optional(),
  runtime: RuntimeConfigSchema.optional(),
});

export type AtlasConfig = z.infer<typeof AtlasConfigSchema>;

// ==============================================================================
// MERGED CONFIGURATION
// ==============================================================================

/**
 * Merged configuration type that keeps workspace and atlas configs separate
 * Used internally after loading configurations
 */
export interface MergedConfig {
  atlas: AtlasConfig | null;
  workspace: WorkspaceConfig;
}

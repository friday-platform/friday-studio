import { z } from "zod";
import { WorkspaceAgentConfigSchema } from "./agents.ts";
import { AtlasServerConfigSchema, ServerConfigSchema } from "./atlas.ts";
import { FederationConfigSchema, MCPToolNameSchema, WorkspaceIdentitySchema } from "./base.ts";
import { JobSpecificationSchema } from "./jobs.ts";
import { AtlasToolsConfigSchema, ToolsConfigSchema } from "./mcp.ts";
import { NotificationConfigSchema } from "./notifications.ts";
import { WorkspaceSignalConfigSchema } from "./signals.ts";
import { SkillEntrySchema } from "./skills.ts";

// ==============================================================================
// RESOURCE DECLARATIONS (config-level schema, strict validation at provisioning)
// ==============================================================================

const ConfigResourceDeclarationSchema = z.union([
  z.object({
    type: z.literal("document"),
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    schema: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("prose"),
    slug: z.string(),
    name: z.string(),
    description: z.string(),
  }),
  z.object({
    type: z.literal("artifact_ref"),
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    artifactId: z.string(),
  }),
  z.object({
    type: z.literal("external_ref"),
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    provider: z.string(),
    ref: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
]);

// ==============================================================================
// WORKSPACE CONFIGURATION (workspace.yml)
// ==============================================================================

export const WorkspaceConfigSchema = z.strictObject({
  version: z.literal("1.0").describe("Configuration version (currently '1.0')"),
  workspace: WorkspaceIdentitySchema,
  server: ServerConfigSchema.optional(),
  tools: ToolsConfigSchema.optional(),
  skills: z.array(SkillEntrySchema).optional(),
  signals: z.record(z.string(), WorkspaceSignalConfigSchema).optional(),
  jobs: z.record(MCPToolNameSchema, JobSpecificationSchema).optional(),
  agents: z.record(z.string(), WorkspaceAgentConfigSchema).optional(),
  resources: z.array(ConfigResourceDeclarationSchema).optional(),
  notifications: NotificationConfigSchema.optional(),
  federation: FederationConfigSchema.optional(),
  improvement: z
    .enum(["surface", "auto"])
    .optional()
    .describe(
      "Workspace-wide improvement policy. 'auto' applies config changes atomically; " +
        "'surface' writes proposals to scratchpad for review. Defaults to 'surface'.",
    ),
  corpus_mounts: z
    .array(
      z.object({
        workspace: z.string(),
        corpus: z.string(),
        kind: z.enum(["narrative", "retrieval", "dedup", "kv"]),
        mode: z.enum(["read", "write", "read_write"]).default("read"),
      }),
    )
    .optional(),
  memory: z
    .object({
      mounts: z
        .array(
          z.object({
            name: z.string(),
            source: z.string(),
            mode: z.enum(["ro", "rw"]).default("ro"),
            scope: z.enum(["workspace", "job", "agent"]),
            scopeTarget: z.string().optional(),
            filter: z.record(z.string(), z.unknown()).optional(),
          }),
        )
        .optional()
        .default([]),
      shareable: z
        .object({
          corpora: z.array(z.string()).optional(),
          allowedWorkspaces: z.array(z.string()).optional(),
        })
        .optional(),
    })
    .optional(),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

// ==============================================================================
// ATLAS CONFIGURATION (atlas.yml - superset of workspace.yml)
// ==============================================================================

export const AtlasConfigSchema = WorkspaceConfigSchema.extend({
  server: AtlasServerConfigSchema.optional(),
  tools: AtlasToolsConfigSchema.optional(),
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

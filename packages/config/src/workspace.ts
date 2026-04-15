import { z } from "zod";
import { WorkspaceAgentConfigSchema } from "./agents.ts";
import { AtlasServerConfigSchema, PlatformModelsSchema, ServerConfigSchema } from "./atlas.ts";
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
// MEMORY SCHEMAS
// ==============================================================================

export const MemoryTypeSchema = z.enum(["short_term", "long_term", "scratchpad"]);

export const MemoryStrategySchema = z.enum(["narrative", "retrieval", "dedup", "kv"]).optional();

export const CorpusKindSchema = z.enum(["narrative", "retrieval", "dedup", "kv"]);

export const MemoryOwnEntrySchema = z.object({
  name: z.string().min(1),
  type: MemoryTypeSchema,
  strategy: MemoryStrategySchema,
});

// _global is GLOBAL_WORKSPACE_ID from @atlas/agent-sdk/memory-scope
const SOURCE_RE =
  /^([A-Za-z0-9_][A-Za-z0-9_-]*|_global)\/(narrative|retrieval|dedup|kv)\/([A-Za-z0-9_][A-Za-z0-9_-]*)$/;

export const MemoryMountSourceSchema = z
  .string()
  .regex(SOURCE_RE, {
    message:
      'memory.mounts[].source must be "{wsId|_global}/{kind}/{memoryName}" ' +
      '— e.g. "thick_endive/narrative/autopilot-backlog"',
  });

export const MountFilterSchema = z.object({
  status: z.union([z.string(), z.array(z.string())]).optional(),
  priority_min: z.number().int().optional(),
  kind: z.union([z.string(), z.array(z.string())]).optional(),
  since: z.string().datetime({ offset: true }).optional(),
});

export type MountFilter = z.infer<typeof MountFilterSchema>;

export const MemoryMountSchema = z
  .object({
    name: z.string().min(1),
    source: MemoryMountSourceSchema,
    mode: z.enum(["ro", "rw"]).default("ro"),
    scope: z.enum(["workspace", "job", "agent"]),
    scopeTarget: z.string().optional(),
    filter: MountFilterSchema.optional(),
  })
  .superRefine((val, ctx) => {
    if (val.scope !== "workspace" && !val.scopeTarget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scopeTarget"],
        message: `scopeTarget is required when scope is "${val.scope}"`,
      });
    }
  });

export type MemoryMount = z.infer<typeof MemoryMountSchema>;

export const MemoryShareableSchema = z.object({
  list: z.array(z.string()).optional(),
  allowedWorkspaces: z.array(z.string()).optional(),
});

export const MemoryConfigSchema = z.object({
  own: z.array(MemoryOwnEntrySchema).optional().default([]),
  mounts: z.array(MemoryMountSchema).optional().default([]),
  shareable: MemoryShareableSchema.optional(),
});

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

export function parseMemoryMountSource(source: string): {
  workspaceId: string;
  kind: z.infer<typeof CorpusKindSchema>;
  memoryName: string;
} {
  const match = SOURCE_RE.exec(source);
  if (!match) {
    throw new Error(`Invalid memory mount source: ${source}`);
  }
  return {
    workspaceId: match[1] ?? "",
    kind: CorpusKindSchema.parse(match[2]),
    memoryName: match[3] ?? "",
  };
}

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
  memory: MemoryConfigSchema.optional(),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

// ==============================================================================
// ATLAS CONFIGURATION (friday.yml - superset of workspace.yml)
// ==============================================================================

export const AtlasConfigSchema = WorkspaceConfigSchema.extend({
  server: AtlasServerConfigSchema.optional(),
  tools: AtlasToolsConfigSchema.optional(),
  models: PlatformModelsSchema.optional(),
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

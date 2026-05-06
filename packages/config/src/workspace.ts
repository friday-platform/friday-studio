import { z } from "zod";
import { WorkspaceAgentConfigSchema } from "./agents.ts";
import { AtlasServerConfigSchema, PlatformModelsSchema, ServerConfigSchema } from "./atlas.ts";
import { FederationConfigSchema, MCPToolNameSchema, WorkspaceIdentitySchema } from "./base.ts";
import { CommunicatorConfigSchema } from "./communicators.ts";
import { JobSpecificationSchema } from "./jobs.ts";
import { AtlasToolsConfigSchema, ToolsConfigSchema } from "./mcp.ts";
import { NotificationConfigSchema } from "./notifications.ts";
import { WorkspaceSignalConfigSchema } from "./signals.ts";
import { SkillEntrySchema } from "./skills.ts";

// ==============================================================================
// MEMORY SCHEMAS
// ==============================================================================

export const MemoryTypeSchema = z.enum(["short_term", "long_term", "scratchpad"]);

export const MemoryStrategySchema = z.literal("narrative").optional();

export const StoreKindSchema = z.literal("narrative");

export const MemoryOwnEntrySchema = z.object({
  name: z.string().min(1),
  type: MemoryTypeSchema,
  strategy: MemoryStrategySchema,
});

// _global is GLOBAL_WORKSPACE_ID from @atlas/agent-sdk/memory-scope
const SOURCE_RE =
  /^([A-Za-z0-9_][A-Za-z0-9_-]*|_global)\/(narrative)\/([A-Za-z0-9_][A-Za-z0-9_-]*)$/;

export const MemoryMountSourceSchema = z
  .string()
  .regex(SOURCE_RE, {
    message:
      'memory.mounts[].source must be "{wsId|_global}/narrative/{memoryName}" ' +
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
  kind: z.infer<typeof StoreKindSchema>;
  memoryName: string;
} {
  const match = SOURCE_RE.exec(source);
  if (!match) {
    throw new Error(`Invalid memory mount source: ${source}`);
  }
  return {
    workspaceId: match[1] ?? "",
    kind: StoreKindSchema.parse(match[2]),
    memoryName: match[3] ?? "",
  };
}

// ==============================================================================
// WORKSPACE CONFIGURATION (workspace.yml)
// ==============================================================================

/**
 * Per-workspace permissions policy.
 *
 * Today: only the allowlist-bypass flag. Future: elicitation policy
 * (which kinds emit elicitations, default expiry, etc.) lands here.
 */
export const PermissionsConfigSchema = z.strictObject({
  /**
   * Workspace-level bypass for tool/skill allowlist enforcement (Phase 1).
   * When `true`, allowlist denials silently pass through with a debug log
   * instead of becoming elicitations or hard failures. Mirrors Claude
   * Code's `--dangerously-skip-permissions` flag — trusted-context-only,
   * never default. The daemon-level env var
   * `FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS=1` enables the same bypass globally;
   * the workspace setting wins (a workspace can opt back into safety even
   * when the daemon is open).
   */
  dangerouslySkipAllowlist: z
    .boolean()
    .optional()
    .describe(
      "Bypass tool/skill allowlist enforcement. Trusted contexts only. " +
        "Workspace setting overrides the FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS daemon flag.",
    ),
});

export type PermissionsConfig = z.infer<typeof PermissionsConfigSchema>;

/**
 * Delegation budgets (Phase 8 of melodic-strolling-seal plan).
 *
 * Bounds on `delegate` tool invocations spawned from chat or FSM type:llm
 * actions. Workspace-level defaults; per-job override via JobSpecification.
 *
 * Today: schema only — runtime enforcement of `max_steps_per_call` and
 * `max_output_tokens` exists today as hardcoded constants in
 * `packages/system/agents/workspace-chat/tools/delegate/index.ts`
 * (CHILD_STEP_BUDGET=40, CHILD_MAX_OUTPUT_TOKENS=20000). Phase 8 promotes
 * those to config-driven and adds depth + wall-clock + input-token + cost.
 */
export const DelegationBudgetSchema = z.strictObject({
  /**
   * Max delegation depth. 1 = parent can call delegate, child cannot
   * re-delegate. 2 = child can delegate once. Etc. Default: 1 (today's
   * hard cap, enforced via tool-list omission in the child).
   */
  max_depth: z.number().int().positive().optional(),
  /** Max steps (tool calls + LLM turns) per delegate child invocation. */
  max_steps_per_call: z.number().int().positive().optional(),
  /** Max output tokens generated by a delegate child. */
  max_output_tokens: z.number().int().positive().optional(),
  /** Max cumulative input tokens across all steps of a delegate child. */
  max_input_tokens: z.number().int().positive().optional(),
  /** Wall-clock budget per delegate invocation, in milliseconds. */
  max_wall_time_ms: z.number().int().positive().optional(),
  /**
   * Cost budget in USD per delegate invocation. Reserved — not enforced
   * until cost-tracking infrastructure lands. Set to null today to make
   * the field's presence explicit without committing to the surface.
   */
  max_cost_usd: z.number().nullable().optional(),
});

export type DelegationBudget = z.infer<typeof DelegationBudgetSchema>;

export const WorkspaceConfigSchema = z.strictObject({
  version: z.literal("1.0").describe("Configuration version (currently '1.0')"),
  workspace: WorkspaceIdentitySchema,
  server: ServerConfigSchema.optional(),
  tools: ToolsConfigSchema.optional(),
  skills: z.array(SkillEntrySchema).optional(),
  signals: z.record(z.string(), WorkspaceSignalConfigSchema).optional(),
  communicators: z.record(z.string(), CommunicatorConfigSchema).optional(),
  jobs: z.record(MCPToolNameSchema, JobSpecificationSchema).optional(),
  agents: z.record(z.string(), WorkspaceAgentConfigSchema).optional(),
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
  permissions: PermissionsConfigSchema.optional(),
  delegation: DelegationBudgetSchema.optional(),
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

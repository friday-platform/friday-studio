import { z } from "zod";

// ── Improvement policy ────────────────────────────────────────────────────────

export const ImprovementModeSchema = z.enum(["surface", "auto"]);
export type ImprovementMode = z.infer<typeof ImprovementModeSchema>;

// ── Memory mount schemas ──────────────────────────────────────────────────────

export const CorpusKindSchema = z.enum(["narrative", "retrieval", "dedup", "kv"]);

const SOURCE_RE =
  /^([A-Za-z0-9_][A-Za-z0-9_-]*|_global)\/(narrative|retrieval|dedup|kv)\/([A-Za-z0-9_][A-Za-z0-9_-]*)$/;

export const MemoryMountSourceSchema = z
  .string()
  .regex(SOURCE_RE, {
    message:
      'memory.mounts[].source must be "{wsId|_global}/{kind}/{corpusName}" ' +
      '— e.g. "thick_endive/narrative/autopilot-backlog"',
  });

export const MemoryMountFilterSchema = z.object({
  status: z.union([z.string(), z.array(z.string())]).optional(),
  priority_min: z.number().optional(),
  kind: z.union([z.string(), z.array(z.string())]).optional(),
  since: z.string().datetime({ offset: true }).optional(),
});

export const MemoryMountSchema = z
  .object({
    name: z.string().min(1),
    source: MemoryMountSourceSchema,
    mode: z.enum(["ro", "rw"]).default("ro"),
    scope: z.enum(["workspace", "job", "agent"]),
    scopeTarget: z.string().optional(),
    filter: MemoryMountFilterSchema.optional(),
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

export const MemoryConfigSchema = z.object({
  mounts: z.array(MemoryMountSchema).default([]),
  shareable: z.record(z.string(), z.array(z.string())).optional(),
});

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

export function parseMemoryMountSource(source: string): {
  workspaceId: string;
  kind: z.infer<typeof CorpusKindSchema>;
  corpusName: string;
} {
  const match = SOURCE_RE.exec(source);
  if (!match) {
    throw new Error(`Invalid memory mount source: ${source}`);
  }
  return {
    workspaceId: match[1] ?? "",
    kind: CorpusKindSchema.parse(match[2]),
    corpusName: match[3] ?? "",
  };
}

const DEFAULT_MODE: ImprovementMode = "surface";

// ── Job / workspace config schemas (Zod) ─────────────────────────────────────

export const JobImprovementConfigSchema = z.object({
  improvement: ImprovementModeSchema.optional(),
});

export type JobImprovementConfig = z.infer<typeof JobImprovementConfigSchema>;

export const WorkspaceImprovementConfigSchema = z.object({
  improvement: ImprovementModeSchema.optional(),
  jobs: z.record(z.string(), JobImprovementConfigSchema).optional(),
});

export type WorkspaceImprovementConfig = z.infer<typeof WorkspaceImprovementConfigSchema>;

export const ImprovementModeRequestSchema = z.object({
  workspaceId: z.string(),
  jobId: z.string().optional(),
  newFullConfig: WorkspaceImprovementConfigSchema,
});

export type ImprovementModeRequest = z.infer<typeof ImprovementModeRequestSchema>;

// ── Resolution helper ────────────────────────────────────────────────────────

export function resolveImprovementMode(
  config: WorkspaceImprovementConfig,
  jobId?: string,
): ImprovementMode {
  if (jobId) {
    const jobPolicy = config.jobs?.[jobId]?.improvement;
    if (jobPolicy) return jobPolicy;
  }
  return config.improvement ?? DEFAULT_MODE;
}

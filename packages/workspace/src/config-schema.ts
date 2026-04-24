import {
  type MemoryConfig,
  MemoryConfigSchema,
  type MemoryMount,
  MemoryMountSchema,
  MemoryMountSourceSchema,
  MemoryOwnEntrySchema,
  MemoryStrategySchema,
  MemoryTypeSchema,
  type MountFilter,
  parseMemoryMountSource,
  StoreKindSchema,
} from "@atlas/config";
import { z } from "zod";

// ── Improvement policy ────────────────────────────────────────────────────────

export const ImprovementModeSchema = z.enum(["surface", "auto"]);
export type ImprovementMode = z.infer<typeof ImprovementModeSchema>;

// ── Memory mount schemas (re-exported from @atlas/config) ────────────────────

export {
  type MemoryConfig,
  MemoryConfigSchema,
  type MemoryMount,
  MemoryMountSchema,
  MemoryMountSourceSchema,
  MemoryOwnEntrySchema,
  MemoryStrategySchema,
  MemoryTypeSchema,
  type MountFilter,
  parseMemoryMountSource,
  StoreKindSchema,
};

export const ImprovementProposalChunkSchema = z.object({
  id: z.string(),
  kind: z.literal("improvement-proposal"),
  body: z.string(),
  createdAt: z.string(),
});

type ImprovementProposalChunk = z.infer<typeof ImprovementProposalChunkSchema>;

const DEFAULT_MODE: ImprovementMode = "surface";

// ── Job / workspace config schemas (Zod) ─────────────────────────────────────

export const JobImprovementConfigSchema = z.object({
  improvement: ImprovementModeSchema.optional(),
});

type JobImprovementConfig = z.infer<typeof JobImprovementConfigSchema>;

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

type ImprovementModeRequest = z.infer<typeof ImprovementModeRequestSchema>;

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

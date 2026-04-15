import { z } from "zod";

// ── Zod schemas ─────────────────────────────────────────────────────────────

export const ScratchpadChunkSchema = z.object({
  id: z.string(),
  kind: z.string(),
  body: z.string(),
  createdAt: z.string(),
});

export const ImprovementTypeSchema = z.enum([
  "skill_update",
  "signal_patch",
  "agent_replace",
  "source_mod",
]);

export const LifecycleImprovementSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  status: z.enum(["pending", "applied", "rejected", "rolled_back"]),
  type: ImprovementTypeSchema,
  diff: z.string(),
  rationale: z.string().optional(),
  target_job_id: z.string().optional(),
  createdAt: z.string(),
});

export const ImprovementFindingBodySchema = z.object({
  kind: z.literal("improvement-finding"),
  target_job_id: z.string(),
  diff: z.string(),
  rationale: z.string().optional(),
  workspace_yml_proposed: z.string().optional(),
  improvement_type: ImprovementTypeSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const ApplyActionRequestSchema = z.object({
  workspaceId: z.string(),
  jobId: z.string().optional(),
  finding: ImprovementFindingBodySchema,
  action: z.enum(["accept", "reject"]).default("accept"),
});

// ── TypeScript types ────────────────────────────────────────────────────────

export type ScratchpadChunk = z.infer<typeof ScratchpadChunkSchema>;

export type ImprovementType = z.infer<typeof ImprovementTypeSchema>;

export type LifecycleImprovement = z.infer<typeof LifecycleImprovementSchema>;

export type ImprovementFindingBody = z.infer<typeof ImprovementFindingBodySchema>;

export type ApplyActionRequest = z.infer<typeof ApplyActionRequestSchema>;

export type ApplyAction = "accept" | "reject" | "dismiss" | "rollback";

export interface ImprovementFinding {
  chunk: ScratchpadChunk;
  body: ImprovementFindingBody;
  workspaceId: string;
}

export interface FindingGroup {
  workspaceId: string;
  jobId: string;
  findings: ImprovementFinding[];
}

export interface WorkspaceGroup {
  workspaceId: string;
  jobs: FindingGroup[];
}

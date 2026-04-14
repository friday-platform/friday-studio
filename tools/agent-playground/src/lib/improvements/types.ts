import { z } from "zod";

// ── Zod schemas ─────────────────────────────────────────────────────────────

export const ScratchpadChunkSchema = z.object({
  id: z.string(),
  kind: z.string(),
  body: z.string(),
  createdAt: z.string(),
});

export const ImprovementFindingBodySchema = z.object({
  kind: z.literal("improvement-finding"),
  target_job_id: z.string(),
  diff: z.string(),
  rationale: z.string().optional(),
  workspace_yml_proposed: z.string().optional(),
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

export type ImprovementFindingBody = z.infer<typeof ImprovementFindingBodySchema>;

export type ApplyActionRequest = z.infer<typeof ApplyActionRequestSchema>;

export type ApplyAction = "accept" | "reject" | "dismiss";

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

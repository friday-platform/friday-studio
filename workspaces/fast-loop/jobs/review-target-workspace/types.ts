import { z } from "zod";

export const ReviewFindingSchema = z.object({
  kind: z.enum(["workspace_drift", "prompt_issue", "fsm_smell"]),
  summary: z.string(),
  detail: z.string(),
  severity: z.enum(["low", "medium", "high"]),
  target_job_id: z.string().optional(),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewJobConfigSchema = z.object({
  targetWorkspaceId: z.string(),
  sessionLimit: z.number().int().positive().default(20),
  notesCorpus: z.string().default("notes"),
  cronExpr: z.string().optional(),
});

export type ReviewJobConfig = z.infer<typeof ReviewJobConfigSchema>;

export const ReviewSignalPayloadSchema = z.object({
  targetWorkspaceId: z.string(),
  sessionLimit: z.number().int().positive().optional(),
});

export type ReviewSignalPayload = z.infer<typeof ReviewSignalPayloadSchema>;

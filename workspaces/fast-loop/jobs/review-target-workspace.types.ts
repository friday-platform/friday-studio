import { z } from "zod";

export const ReviewFindingSchema = z.object({
  category: z.enum(["drift", "prompt", "fsm"]),
  severity: z.enum(["info", "warn", "error"]),
  summary: z.string(),
  detail: z.string(),
  target_job_id: z.string().nullable().optional(),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewJobInputSchema = z.object({
  targetWorkspaceId: z.string(),
  sessionLimit: z.number().int().positive().optional(),
  jobIds: z.array(z.string()).optional(),
});

export type ReviewJobInput = z.infer<typeof ReviewJobInputSchema>;

export const ReviewFindingResultSchema = ReviewFindingSchema.extend({
  id: z.string(),
  createdAt: z.string(),
});

export type ReviewFindingResult = z.infer<typeof ReviewFindingResultSchema>;

export const ReviewJobResultSchema = z.object({
  targetWorkspaceId: z.string(),
  findings: z.array(ReviewFindingResultSchema),
  appendedCount: z.number().int(),
  ranAt: z.string(),
});

export type ReviewJobResult = z.infer<typeof ReviewJobResultSchema>;

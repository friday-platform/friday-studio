import { z } from "zod";

export const ReviewJobInputSchema = z.object({
  targetWorkspaceId: z.string(),
  sessionLimit: z.number().int().positive().optional(),
});

export type ReviewJobInput = z.infer<typeof ReviewJobInputSchema>;

export const ReviewFindingSchema = z.object({
  text: z.string(),
  category: z.enum(["workspace-drift", "agent-prompt", "fsm-smell"]),
  severity: z.enum(["info", "warn", "error"]),
  targetJobId: z.string().optional(),
});

export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

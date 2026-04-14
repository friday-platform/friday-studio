import type { NarrativeEntry } from "@atlas/agent-sdk";
import { z } from "zod";

export type FindingCategory = "drift" | "prompt" | "fsm";
export type FindingSeverity = "info" | "warning" | "error";

export interface FindingEntry {
  id: string;
  text: string;
  author: "reviewer-agent";
  createdAt: string;
  metadata: {
    category: FindingCategory;
    severity: FindingSeverity;
    target_job_id?: string;
    evidence?: string;
  };
}

export const FindingEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  author: z.literal("reviewer-agent"),
  createdAt: z.string(),
  metadata: z.object({
    category: z.enum(["drift", "prompt", "fsm"]),
    severity: z.enum(["info", "warning", "error"]),
    target_job_id: z.string().optional(),
    evidence: z.string().optional(),
  }),
});

export const ReviewJobInputSchema = z.object({
  targetWorkspaceId: z.string(),
  sessionLimit: z.number().int().positive().default(20),
});

export type ReviewJobInput = z.infer<typeof ReviewJobInputSchema>;

export const ReviewJobSignalPayloadSchema = z.object({
  signal: z.literal("review-requested"),
  targetWorkspaceId: z.string(),
  sessionLimit: z.number().int().positive().optional(),
});

export type ReviewJobSignalPayload = z.infer<typeof ReviewJobSignalPayloadSchema>;

export function toNarrativeEntry(finding: FindingEntry): NarrativeEntry {
  return {
    id: finding.id,
    text: finding.text,
    author: finding.author,
    createdAt: finding.createdAt,
    metadata: {
      category: finding.metadata.category,
      severity: finding.metadata.severity,
      target_job_id: finding.metadata.target_job_id,
      evidence: finding.metadata.evidence,
    },
  };
}

import { z } from "zod";
import type { NarrativeEntry } from "@atlas/agent-sdk";

export const ImprovementFindingMetaSchema = z.object({
  kind: z.literal("improvement-finding"),
  workspaceId: z.string(),
  target_job_id: z.string(),
  proposed_diff: z.string(),
  proposed_full_config: z.string(),
  improvement_mode: z.enum(["surface", "auto"]),
});

export type ImprovementFindingMeta = z.infer<typeof ImprovementFindingMetaSchema>;

export const ImprovementFindingSchema = z.object({
  id: z.string(),
  text: z.string(),
  author: z.string().optional(),
  createdAt: z.string(),
  metadata: ImprovementFindingMetaSchema,
});

export type ImprovementFinding = z.infer<typeof ImprovementFindingSchema>;

export const DaemonApplyPayloadSchema = z.object({
  findingId: z.string(),
  workspaceId: z.string(),
  target_job_id: z.string(),
});

export type DaemonApplyPayload = z.infer<typeof DaemonApplyPayloadSchema>;

export function asImprovementFinding(entry: NarrativeEntry): ImprovementFinding | null {
  const parsed = ImprovementFindingSchema.safeParse(entry);
  return parsed.success ? parsed.data : null;
}

export function groupFindings(
  entries: NarrativeEntry[],
): Map<string, Map<string, ImprovementFinding[]>> {
  const result = new Map<string, Map<string, ImprovementFinding[]>>();

  for (const entry of entries) {
    const finding = asImprovementFinding(entry);
    if (!finding) continue;

    const { workspaceId, target_job_id } = finding.metadata;

    let jobMap = result.get(workspaceId);
    if (!jobMap) {
      jobMap = new Map();
      result.set(workspaceId, jobMap);
    }

    let list = jobMap.get(target_job_id);
    if (!list) {
      list = [];
      jobMap.set(target_job_id, list);
    }

    list.push(finding);
  }

  return result;
}

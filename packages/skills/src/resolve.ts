import { createLogger } from "@atlas/logger";
import type { SkillSummary } from "./schemas.ts";
import type { SkillStorageAdapter } from "./storage.ts";

const logger = createLogger({ name: "skill-resolve" });

export interface ResolveVisibleSkillsOptions {
  /**
   * When provided, adds skills explicitly assigned to `(workspaceId, jobName)`
   * on top of the workspace-level layer. When omitted, the job layer is empty.
   *
   * Additive only: a job never *loses* access to workspace-level or global
   * skills because it has a job-level layer. Runtime visible set is:
   *   all_catalog_skills ∪ workspace_assigned ∪ job_assigned(workspace, jobName)
   */
  jobName?: string;
}

/**
 * Resolve the full set of skills visible to a workspace (and optionally a
 * specific job inside it):
 *
 *   (all non-disabled named skills in the catalog, minus job-only-scoped)
 *   ∪ (skills assigned workspace-level to this workspace)
 *   ∪ (skills assigned at the job level, when options.jobName is set)
 *
 * The assignment table is additive and organizational at the workspace
 * level — assigning a skill to one workspace does not remove it from
 * others. Job-level assignments are different: they make a skill private
 * to its owning (workspace, job) pairs, so a skill that exists *only* as
 * job-level rows is filtered out of the catalog pool and surfaced only
 * through the matching `listAssignmentsForJob`. Disabled skills are
 * excluded globally. Deduplicates by skillId.
 */
export async function resolveVisibleSkills(
  workspaceId: string,
  skills: SkillStorageAdapter,
  options: ResolveVisibleSkillsOptions = {},
): Promise<SkillSummary[]> {
  const { jobName } = options;

  const [allResult, directResult, jobResult, jobOnlyResult] = await Promise.all([
    skills.list(),
    skills.listAssigned(workspaceId),
    jobName
      ? skills.listAssignmentsForJob(workspaceId, jobName)
      : Promise.resolve({ ok: true as const, data: [] as SkillSummary[] }),
    skills.listJobOnlySkillIds(),
  ]);

  if (!allResult.ok) {
    logger.warn("Failed to list all skills", { error: allResult.error, workspaceId });
  }
  if (!directResult.ok) {
    logger.warn("Failed to list assigned skills", { error: directResult.error, workspaceId });
  }
  if (!jobResult.ok) {
    logger.warn("Failed to list job-assigned skills", {
      error: jobResult.error,
      workspaceId,
      jobName,
    });
  }
  if (!jobOnlyResult.ok) {
    logger.warn("Failed to list job-only skill ids", { error: jobOnlyResult.error, workspaceId });
  }

  const jobOnlyIds = new Set(jobOnlyResult.ok ? jobOnlyResult.data : []);
  const all = (allResult.ok ? allResult.data : []).filter((s) => !jobOnlyIds.has(s.skillId));
  const direct = directResult.ok ? directResult.data : [];
  const jobAssigned = jobResult.ok ? jobResult.data : [];

  const seen = new Set<string>();
  const result: SkillSummary[] = [];
  for (const skill of [...all, ...direct, ...jobAssigned]) {
    if (!seen.has(skill.skillId)) {
      seen.add(skill.skillId);
      result.push(skill);
    }
  }
  return result;
}

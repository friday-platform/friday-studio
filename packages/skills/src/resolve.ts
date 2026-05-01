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
   *   global_unassigned ∪ workspace_assigned ∪ job_assigned(workspace, jobName)
   */
  jobName?: string;
}

/**
 * Resolve the full set of skills visible to a workspace (and optionally a
 * specific job inside it):
 *
 *   (skills with no assignments)
 *   ∪ (skills assigned workspace-level to this workspace)
 *   ∪ (skills assigned at the job level, when options.jobName is set)
 *
 * Skills with no `skill_assignments` rows are global; workspace-level rows
 * (`job_name IS NULL`) are visible to every job in the workspace; job-level
 * rows are visible *only* to the specified job.
 *
 * Deduplicates by skillId so a skill assigned at multiple layers appears once.
 */
export async function resolveVisibleSkills(
  workspaceId: string,
  skills: SkillStorageAdapter,
  options: ResolveVisibleSkillsOptions = {},
): Promise<SkillSummary[]> {
  const { jobName } = options;

  const [unassignedResult, directResult, jobResult] = await Promise.all([
    skills.listUnassigned(),
    skills.listAssigned(workspaceId),
    jobName
      ? skills.listAssignmentsForJob(workspaceId, jobName)
      : Promise.resolve({ ok: true as const, data: [] as SkillSummary[] }),
  ]);

  if (!unassignedResult.ok) {
    logger.warn("Failed to list unassigned skills", { error: unassignedResult.error, workspaceId });
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

  const unassigned = unassignedResult.ok ? unassignedResult.data : [];
  const direct = directResult.ok ? directResult.data : [];
  const jobAssigned = jobResult.ok ? jobResult.data : [];

  const seen = new Set<string>();
  const result: SkillSummary[] = [];
  for (const skill of [...unassigned, ...direct, ...jobAssigned]) {
    if (!seen.has(skill.skillId)) {
      seen.add(skill.skillId);
      result.push(skill);
    }
  }
  return result;
}

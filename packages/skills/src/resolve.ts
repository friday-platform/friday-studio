import { createLogger } from "@atlas/logger";
import type { SkillSummary } from "./schemas.ts";
import type { SkillStorageAdapter } from "./storage.ts";

const logger = createLogger({ name: "skill-resolve" });

/**
 * Resolve the full set of skills visible to a workspace:
 *   (skills with no assignments) ∪ (skills assigned to this workspace)
 *
 * Skills with no `skill_assignments` rows are global; skills with assignments
 * are visible only to the workspaces they are assigned to.
 *
 * Deduplicates by skillId for safety, though by construction an unassigned
 * skill cannot also be in the assigned set.
 */
export async function resolveVisibleSkills(
  workspaceId: string,
  skills: SkillStorageAdapter,
): Promise<SkillSummary[]> {
  const [unassignedResult, directResult] = await Promise.all([
    skills.listUnassigned(),
    skills.listAssigned(workspaceId),
  ]);

  if (!unassignedResult.ok) {
    logger.warn("Failed to list unassigned skills", { error: unassignedResult.error, workspaceId });
  }
  if (!directResult.ok) {
    logger.warn("Failed to list assigned skills", { error: directResult.error, workspaceId });
  }

  const unassigned = unassignedResult.ok ? unassignedResult.data : [];
  const direct = directResult.ok ? directResult.data : [];

  const seen = new Set<string>();
  const result: SkillSummary[] = [];
  for (const skill of [...unassigned, ...direct]) {
    if (!seen.has(skill.skillId)) {
      seen.add(skill.skillId);
      result.push(skill);
    }
  }
  return result;
}

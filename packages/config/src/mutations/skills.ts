/**
 * Skill mutation functions for workspace configuration partial updates
 *
 * Pure functions that transform WorkspaceConfig, returning MutationResult.
 * No side effects - callers are responsible for persistence.
 */

import { produce } from "immer";
import { SkillRefSchema } from "../skills.ts";
import type { WorkspaceConfig } from "../workspace.ts";
import { conflictError, type MutationResult, notFoundError, validationError } from "./types.ts";

/**
 * Removes a skill binding from the workspace configuration.
 * Matches by the skill's `name` field (e.g., `@ns/skill-name` for catalog refs,
 * or bare name for inline skills).
 *
 * @param config - Current workspace configuration
 * @param skillName - Name of the skill to remove
 * @returns MutationResult with updated config or not_found error
 */
export function removeSkill(
  config: WorkspaceConfig,
  skillName: string,
): MutationResult<WorkspaceConfig> {
  const skills = config.skills ?? [];
  const index = skills.findIndex((s) => s.name === skillName);

  if (index === -1) {
    return { ok: false, error: notFoundError(skillName, "skill") };
  }

  return {
    ok: true,
    value: produce(config, (draft) => {
      if (draft.skills) {
        draft.skills.splice(index, 1);
        if (draft.skills.length === 0) {
          delete draft.skills;
        }
      }
    }),
  };
}

/**
 * Adds a catalog skill binding to the workspace configuration.
 * The skillRef must be in `@namespace/skill-name` format.
 * Fails if the skill is already bound.
 *
 * @param config - Current workspace configuration
 * @param skillRef - Catalog skill reference (e.g., `@my-ns/my-skill`)
 * @returns MutationResult with updated config or error
 */
export function addSkill(
  config: WorkspaceConfig,
  skillRef: string,
): MutationResult<WorkspaceConfig> {
  const refResult = SkillRefSchema.safeParse(skillRef);
  if (!refResult.success) {
    return {
      ok: false,
      error: validationError(`Invalid skill ref: ${skillRef}`, refResult.error.issues),
    };
  }

  const skills = config.skills ?? [];
  const alreadyBound = skills.some((s) => s.name === skillRef);
  if (alreadyBound) {
    return { ok: false, error: conflictError() };
  }

  return {
    ok: true,
    value: produce(config, (draft) => {
      draft.skills ??= [];
      draft.skills.push({ name: skillRef });
    }),
  };
}

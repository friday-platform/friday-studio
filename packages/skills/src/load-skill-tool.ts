import { logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";
import { SkillStorage } from "./storage.ts";

const LoadSkillInputSchema = z.object({
  name: z.string().describe("Skill name from <available_skills>"),
  reason: z.string().optional().describe("Why are you loading this skill?"),
});

/**
 * Hardcoded skill definition for bundled skills that don't require database lookup.
 */
export interface HardcodedSkill {
  id: string;
  description: string;
  instructions: string;
}

export interface CreateLoadSkillToolOptions {
  /**
   * Hardcoded skills that take precedence over workspace skills.
   * Checked first before falling back to SkillStorage.
   */
  hardcodedSkills?: readonly HardcodedSkill[];
}

/**
 * Creates a load_skill tool that checks hardcoded skills first (if provided),
 * then falls back to workspace skills via SkillStorage.
 *
 * @param workspaceId - The workspace to scope skill lookups to
 * @param options - Optional configuration including hardcoded skills
 */
export function createLoadSkillTool(workspaceId: string, options: CreateLoadSkillToolOptions = {}) {
  const { hardcodedSkills = [] } = options;
  const hardcodedIds = hardcodedSkills.map((s) => s.id);

  // Build description based on whether hardcoded skills are available
  const baseInstruction =
    "Load skill instructions BEFORE starting a task that matches a skill's description. " +
    "Skills contain step-by-step guidance you should follow. " +
    "Check <available_skills> - if your task matches, load the skill first.";

  const description =
    hardcodedSkills.length > 0
      ? `${baseInstruction} Built-in skills: ${hardcodedIds.join(", ")}. Workspace skills also available.`
      : baseInstruction;

  return tool({
    description,
    inputSchema: LoadSkillInputSchema,
    execute: async ({ name, reason }) => {
      logger.info("skill_load_requested", { skill: name, reason, workspaceId });

      // Check hardcoded skills first (if any)
      const hardcodedSkill = hardcodedSkills.find((s) => s.id === name);
      if (hardcodedSkill) {
        logger.info("skill_loaded", { skill: name, source: "hardcoded", reason });
        return {
          name: hardcodedSkill.id,
          description: hardcodedSkill.description,
          instructions: hardcodedSkill.instructions,
        };
      }

      // Fall back to workspace skills via SkillStorage
      const result = await SkillStorage.getByName(name, workspaceId);
      if (!result.ok) {
        logger.warn("skill_load_failed", { skill: name, error: result.error });
        return { error: result.error };
      }

      if (!result.data) {
        const sources =
          hardcodedSkills.length > 0 ? "built-in skills or workspace" : "<available_skills>";
        logger.warn("skill_not_found", { skill: name, workspaceId });
        return { error: `Skill "${name}" not found. Check ${sources}.` };
      }

      logger.info("skill_loaded", { skill: name, source: "workspace", reason });
      return {
        name: result.data.name,
        description: result.data.description,
        instructions: result.data.instructions,
      };
    },
  });
}

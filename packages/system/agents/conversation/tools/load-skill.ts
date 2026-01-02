import { logger } from "@atlas/logger";
import { tool } from "ai";
import { z } from "zod";
import { type SkillId, skills } from "../skills/index.ts";

const skillIds = skills.map((s) => s.id) as [SkillId, ...SkillId[]];

export const loadSkillTool = tool({
  description: `Load skill instructions. Available: ${skillIds.join(", ")}`,
  inputSchema: z.object({
    id: z.enum(skillIds),
    reason: z.string().optional().describe("Why are you loading this skill?"),
  }),
  execute: ({ id, reason }) => {
    logger.info("skill_loaded", { skill: id, reason });
    const skill = skills.find((s) => s.id === id);
    if (!skill) return { error: `Skill ${id} not found` };
    return { skill: id, instructions: skill.instructions };
  },
});

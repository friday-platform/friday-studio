import { workspaceCreationSkill } from "./workspace-creation/skill.ts";

/**
 * Skill definition for conversation agent capabilities.
 * Skills provide context-specific instructions that the agent can load on demand.
 */
export interface Skill {
  id: string;
  description: string;
  instructions: string;
}

export const skills = [workspaceCreationSkill] as const;
export type SkillId = (typeof skills)[number]["id"];

/**
 * Format skills as XML section for system prompt injection.
 */
export function formatSkillsSection(): string {
  return `<available_skills>
<instruction>Load skills with load_skill when task matches.</instruction>
${skills.map((s) => `<skill id="${s.id}">${s.description}</skill>`).join("\n")}
</available_skills>`;
}

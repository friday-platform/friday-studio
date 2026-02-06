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

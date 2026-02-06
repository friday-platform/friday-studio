import type { SkillSummary } from "./schemas.ts";

export function formatAvailableSkills(skills: SkillSummary[]): string {
  if (!skills.length) return "";

  const entries = skills.map((skill) => `<skill name="${skill.name}">${skill.description}</skill>`);

  return `<available_skills>
${entries.join("\n")}
</available_skills>`;
}

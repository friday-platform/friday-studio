/** Minimal skill info needed for formatting the available skills prompt block */
interface SkillInfo {
  name: string;
  description: string;
}

/**
 * Format skills as an XML block for agent prompts.
 * Callers (InlineSkillConfigSchema, PublishSkillInputSchema) validate that names and
 * descriptions contain no `<` or `>` via noXmlTags schema refinements, so the values
 * interpolated here are safe to embed in XML.
 */
export function formatAvailableSkills(skills: SkillInfo[]): string {
  if (!skills.length) return "";

  const entries = skills.map((skill) => `<skill name="${skill.name}">${skill.description}</skill>`);

  return `<available_skills>
${entries.join("\n")}
</available_skills>`;
}

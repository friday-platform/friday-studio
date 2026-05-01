import { define } from "gunshi";
import { exitWithError, skillsApi } from "./api.ts";

interface SkillListItem {
  id: string;
  skillId: string;
  namespace: string;
  name: string | null;
  description: string;
  disabled: boolean;
  latestVersion: number;
  createdAt: string;
}

export const listCommand = define({
  name: "list",
  description: "List published skills",
  args: {
    namespace: { type: "string", short: "n", description: "Filter by namespace (e.g. tempest)" },
    query: { type: "string", short: "q", description: "Search query" },
    all: { type: "boolean", description: "Include disabled skills", default: false },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  rendering: { header: null },
  run: async (ctx) => {
    const params = new URLSearchParams();
    if (ctx.values.namespace) params.set("namespace", ctx.values.namespace);
    if (ctx.values.query) params.set("query", ctx.values.query);
    if (ctx.values.all) params.set("includeAll", "true");

    const qs = params.toString();
    const result = await skillsApi<{ skills: SkillListItem[] }>(qs ? `?${qs}` : "");

    if (!result.ok) exitWithError(result.error);

    const { skills } = result.data;

    if (ctx.values.json) {
      console.log(JSON.stringify({ skills }, null, 2));
      return;
    }

    if (skills.length === 0) {
      console.log("No skills found.");
      return;
    }

    for (const skill of skills) {
      const disabled = skill.disabled ? " (disabled)" : "";
      console.log(`@${skill.namespace}/${skill.name} v${skill.latestVersion}${disabled}`);
      if (skill.description) {
        console.log(`  ${skill.description.slice(0, 100)}`);
      }
    }
  },
});

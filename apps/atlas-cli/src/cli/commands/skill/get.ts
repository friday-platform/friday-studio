import { define } from "gunshi";
import { exitWithError, parseSkillRef, skillsApi } from "./api.ts";

interface SkillDetail {
  id: string;
  skillId: string;
  namespace: string;
  name: string;
  version: number;
  description: string;
  disabled: boolean;
  createdAt: string;
}

export const getCommand = define({
  name: "get",
  description: "Get skill details",
  args: {
    name: {
      type: "string",
      short: "n",
      required: true,
      description: "Skill name in @namespace/name format",
    },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  rendering: { header: null },
  run: async (ctx) => {
    const name = ctx.values.name;
    if (!name) exitWithError("--name is required (e.g. @tempest/pr-code-review)");

    const parsed = parseSkillRef(name);
    if (!parsed) exitWithError(`Invalid skill name "${name}". Use @namespace/name format.`);

    const result = await skillsApi<{ skill: SkillDetail }>(`/@${parsed.namespace}/${parsed.name}`);

    if (!result.ok) exitWithError(result.error);

    if (ctx.values.json) {
      console.log(JSON.stringify(result.data, null, 2));
      return;
    }

    const { skill } = result.data;
    console.log(`@${skill.namespace}/${skill.name} v${skill.version}`);
    console.log(`  ID: ${skill.skillId}`);
    if (skill.description) console.log(`  Description: ${skill.description}`);
    console.log(`  Created: ${skill.createdAt}`);
    if (skill.disabled) console.log(`  Status: disabled`);
  },
});

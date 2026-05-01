import { define } from "gunshi";
import { exitWithError, parseSkillRef, skillsApi } from "./api.ts";

interface SkillVersion {
  version: number;
  createdAt: string;
}

export const versionsCommand = define({
  name: "versions",
  description: "List all versions of a skill",
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

    const result = await skillsApi<{ versions: SkillVersion[] }>(
      `/@${parsed.namespace}/${parsed.name}/versions`,
    );

    if (!result.ok) exitWithError(result.error);

    const { versions } = result.data;

    if (ctx.values.json) {
      console.log(JSON.stringify({ versions }, null, 2));
      return;
    }

    if (versions.length === 0) {
      console.log("No versions found.");
      return;
    }

    for (const v of versions) {
      console.log(`  v${v.version}  ${v.createdAt}`);
    }
  },
});

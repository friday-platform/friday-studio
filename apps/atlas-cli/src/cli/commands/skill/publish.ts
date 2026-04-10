import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { define } from "gunshi";
import { createArchive } from "./archive.ts";

interface PublishResult {
  published: { id: string; skillId: string; namespace: string; name: string; version: number };
}

export const publishCommand = define({
  name: "publish",
  description: "Publish a skill from a directory",
  args: {
    path: {
      type: "string",
      short: "p",
      description: "Path to skill directory (must contain SKILL.md)",
      default: ".",
    },
    name: {
      type: "string",
      short: "n",
      description: "Skill name in @namespace/name format (overrides SKILL.md frontmatter)",
    },
    json: { type: "boolean", description: "Output as JSON", default: false },
  },
  rendering: { header: null },
  run: async (ctx) => {
    const skillDir = resolve(ctx.values.path ?? ".");

    // Read SKILL.md
    const skillMdPath = `${skillDir}/SKILL.md`;
    let skillMd: string;
    try {
      skillMd = await readFile(skillMdPath, "utf-8");
    } catch {
      console.error(`Error: SKILL.md not found at ${skillMdPath}`);
      process.exit(1);
    }

    // Determine namespace/name from --name flag or SKILL.md frontmatter
    const ref = resolveSkillRef(ctx.values.name, skillMd);
    if (!ref) {
      console.error(
        "Error: Could not determine skill name. Use --name @namespace/name or set name in SKILL.md frontmatter.",
      );
      process.exit(1);
    }

    // Create tar.gz archive of the skill directory
    const archiveBuffer = await createArchive(skillDir);

    // Upload via multipart form
    const baseUrl = getAtlasDaemonUrl();
    const url = `${baseUrl}/api/skills/@${ref.namespace}/${ref.name}/upload`;

    const form = new FormData();
    form.append(
      "archive",
      new File([archiveBuffer], `${ref.name}.tar.gz`, { type: "application/gzip" }),
    );
    form.append("skillMd", skillMd);

    const response = await fetch(url, { method: "POST", body: form });

    if (!response.ok) {
      const body = await response.text();
      console.error(`Error: Upload failed (${response.status}): ${body}`);
      process.exit(1);
    }

    const data = (await response.json()) as PublishResult;

    if (ctx.values.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    console.log(`Published @${ref.namespace}/${data.published.name} v${data.published.version}`);
  },
});

function resolveSkillRef(
  flagName: string | undefined,
  skillMd: string,
): { namespace: string; name: string } | null {
  // --name flag takes priority
  if (flagName) {
    const match = flagName.match(/^@([a-z0-9-]+)\/([a-z0-9-]+)$/);
    if (match?.[1] && match[2]) return { namespace: match[1], name: match[2] };
    return null;
  }

  // Fall back to SKILL.md frontmatter name field
  const nameMatch = skillMd.match(/^name:\s*(.+)$/m);
  if (!nameMatch?.[1]) return null;

  const name = nameMatch[1].trim();
  // If the name in frontmatter is just the skill name (no namespace), default to @tempest
  if (name.includes("/")) {
    const parts = name.replace(/^@/, "").split("/");
    if (!parts[0] || !parts[1]) return null;
    return { namespace: parts[0], name: parts[1] };
  }
  return { namespace: "tempest", name };
}

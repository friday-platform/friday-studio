/**
 * `describe_skill` — fetch a skill's metadata (name, description,
 * version, namespace) WITHOUT loading the full body.
 *
 * Companion to `load_skill`:
 *   - <available_skills> in the system prompt now lists names only.
 *   - Call `describe_skill(name)` to read the description before
 *     deciding whether to `load_skill(name)` for the body.
 *   - Cheap on tokens — typical metadata payload is ~1% of the body.
 *
 * Provenance: `system-config` — workspace's skill catalog is internal
 * authoritative state.
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import { parseSkillRef } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { resolveVisibleSkills, SkillStorage } from "@atlas/skills";
import { tool } from "ai";
import { z } from "zod";
import { envelope, type ReadResponse } from "./envelope.ts";

const DescribeSkillInput = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      "Fully-qualified skill name from <available_skills>, e.g. `@friday/writing-to-memory`",
    ),
});

export interface SkillMetadata {
  name: string;
  namespace: string;
  description: string;
  version: number;
  disabled: boolean;
}

export function createDescribeSkillTool(workspaceId: string, logger: Logger): AtlasTools {
  return {
    describe_skill: tool({
      description:
        "Read a single skill's description + version metadata WITHOUT " +
        "loading the body. Use this to decide whether `load_skill` is " +
        "warranted. Names are visible in <available_skills>; descriptions " +
        "and versions are pull-only via this tool.",
      inputSchema: DescribeSkillInput,
      execute: async ({ name }): Promise<ReadResponse<SkillMetadata> | { error: string }> => {
        let parsed: { namespace: string; name: string };
        try {
          parsed = parseSkillRef(name);
        } catch (err) {
          return { error: `Invalid skill ref \`${name}\`: ${String(err)}` };
        }

        // Defense in depth: only describe skills visible to this workspace,
        // matching `load_skill`'s visibility filter. Prevents a probe of
        // catalog-wide skill names that aren't actually available here.
        const visible = await resolveVisibleSkills(workspaceId, SkillStorage);
        const inScope = visible.find(
          (s) => s.namespace === parsed.namespace && s.name === parsed.name,
        );
        if (!inScope) {
          return {
            error:
              `Skill \`${name}\` is not visible to workspace \`${workspaceId}\`. ` +
              `Check <available_skills> for the exact name.`,
          };
        }

        const result = await SkillStorage.get(parsed.namespace, parsed.name);
        if (!result.ok) {
          logger.warn("describe_skill: SkillStorage.get failed", {
            workspaceId,
            name,
            error: result.error,
          });
          return { error: `Skill lookup failed: ${result.error}` };
        }
        if (!result.data) {
          return { error: `Skill \`${name}\` not found.` };
        }

        const meta: SkillMetadata = {
          name: result.data.name ?? parsed.name,
          namespace: result.data.namespace,
          description: result.data.description,
          version: result.data.version,
          disabled: result.data.disabled,
        };

        return envelope({
          items: [meta],
          source: "system-config",
          origin: `skill:${parsed.namespace}/${parsed.name}`,
        });
      },
    }),
  };
}

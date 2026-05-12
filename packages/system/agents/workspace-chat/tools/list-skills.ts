import type { AtlasTools } from "@atlas/agent-sdk";
import { parseSkillRef, SkillRefSchema } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { resolveVisibleSkills, SkillStorage, type SkillSummary } from "@atlas/skills";
import { tool } from "ai";
import { z } from "zod";

const SkillScope = z
  .enum(["workspace", "catalog"])
  .default("workspace")
  .describe(
    "Where to look. 'workspace' (default) is the set visible to this chat's workspace " +
      "(catalog ∪ direct assignments, minus job-only skills). 'catalog' is the global " +
      "skill catalog ignoring workspace assignment. Most natural questions are 'what " +
      "do I have here?' so the default rarely needs to change.",
  );

const ListSkillsInput = z.object({ scope: SkillScope.optional() });

const SearchSkillsInput = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "Substring matched against skill name and description (case-insensitive). " +
        "Returns the top-K skills ranked by name match first, then description match.",
    ),
  scope: SkillScope.optional(),
  k: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .optional()
    .describe("Maximum number of skills to return. Defaults to 10, hard cap 50."),
});

const DescribeSkillInput = z.object({
  ref: SkillRefSchema.describe(
    "Skill reference in @namespace/skill-name format (e.g. @svelte/core-bestpractices). " +
      "Use list_skills or search_skills to discover valid refs.",
  ),
});

export interface SkillEntry {
  ref: string;
  namespace: string;
  name: string;
  description: string;
  latestVersion: number;
  source?: string;
}

export interface ListSkillsSuccess {
  ok: true;
  scope: "workspace" | "catalog";
  skills: SkillEntry[];
  count: number;
}

export interface DescribeSkillSuccess {
  ok: true;
  ref: string;
  namespace: string;
  name: string;
  description: string;
  latestVersion: number;
  source?: string;
}

export interface SkillToolError {
  ok: false;
  error: string;
}

function toEntry(s: SkillSummary): SkillEntry | null {
  if (!s.name) return null;
  const ref = `@${s.namespace}/${s.name}`;
  const entry: SkillEntry = {
    ref,
    namespace: s.namespace,
    name: s.name,
    description: s.description,
    latestVersion: s.latestVersion,
  };
  if (s.source) entry.source = s.source;
  return entry;
}

async function loadScopedSkills(
  workspaceId: string,
  scope: "workspace" | "catalog",
): Promise<SkillSummary[]> {
  if (scope === "catalog") {
    const result = await SkillStorage.list();
    return result.ok ? result.data : [];
  }
  return resolveVisibleSkills(workspaceId, SkillStorage);
}

/**
 * Build the `list_skills` retrieval tool for workspace chat.
 *
 * Returns a names + one-line summary index of the skills visible to a scope.
 * For the full skill body, the LLM should call `describe_skill(ref)` then
 * `load_skill(name)` when it intends to actually use the skill in a turn.
 */
export function createListSkillsTool(defaultWorkspaceId: string, logger: Logger): AtlasTools {
  return {
    list_skills: tool({
      description:
        "List skills visible to a scope. Use this to discover what skills exist before " +
        "loading or describing one. Returns name + ref + one-line description per skill — " +
        "for the full body call describe_skill(ref); to bring a skill into chat context " +
        "call load_skill(ref). Default scope is 'workspace' (skills visible to this chat); " +
        "pass scope='catalog' to inspect the global skill catalog instead. " +
        "Inventory questions like 'what skills do I have?' route here, not to list_capabilities.",
      inputSchema: ListSkillsInput,
      execute: async ({ scope }): Promise<ListSkillsSuccess | SkillToolError> => {
        const target = scope ?? "workspace";
        try {
          const summaries = await loadScopedSkills(defaultWorkspaceId, target);
          const skills = summaries
            .map(toEntry)
            .filter((e): e is SkillEntry => e !== null)
            .sort((a, b) => a.ref.localeCompare(b.ref));
          logger.info("list_skills succeeded", {
            scope: target,
            workspaceId: defaultWorkspaceId,
            count: skills.length,
          });
          return { ok: true, scope: target, skills, count: skills.length };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("list_skills failed", { scope: target, error: message });
          return { ok: false, error: `list_skills failed: ${message}` };
        }
      },
    }),
  };
}

/**
 * Build the `search_skills` retrieval tool for workspace chat.
 *
 * Substring search over name + description. Name matches rank above description
 * matches; ties break alphabetically by ref. Returns the top-K hits with the
 * full description text so the LLM can pick which skill to inspect or load.
 */
export function createSearchSkillsTool(defaultWorkspaceId: string, logger: Logger): AtlasTools {
  return {
    search_skills: tool({
      description:
        "Search for skills by substring match against name and description. Returns the " +
        "top-K matches with their refs and descriptions. Prefer this over list_skills " +
        "when you have a domain in mind (e.g. 'react', 'gmail', 'qa'). Default scope is " +
        "'workspace'; pass scope='catalog' to search the global catalog. Each result is " +
        "ready to feed into describe_skill or load_skill.",
      inputSchema: SearchSkillsInput,
      execute: async ({ query, scope, k }): Promise<ListSkillsSuccess | SkillToolError> => {
        const target = scope ?? "workspace";
        const limit = k ?? 10;
        try {
          const summaries = await loadScopedSkills(defaultWorkspaceId, target);
          const q = query.toLowerCase();
          const ranked: Array<{ entry: SkillEntry; score: number }> = [];
          for (const s of summaries) {
            const entry = toEntry(s);
            if (!entry) continue;
            const nameHit = entry.name.toLowerCase().includes(q);
            const descHit = entry.description.toLowerCase().includes(q);
            if (!nameHit && !descHit) continue;
            ranked.push({ entry, score: nameHit ? 0 : 1 });
          }
          ranked.sort((a, b) => a.score - b.score || a.entry.ref.localeCompare(b.entry.ref));
          const skills = ranked.slice(0, limit).map((r) => r.entry);
          logger.info("search_skills succeeded", {
            scope: target,
            query,
            matched: ranked.length,
            returned: skills.length,
          });
          return { ok: true, scope: target, skills, count: skills.length };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("search_skills failed", { scope: target, query, error: message });
          return { ok: false, error: `search_skills failed: ${message}` };
        }
      },
    }),
  };
}

/**
 * Build the `describe_skill` retrieval tool for workspace chat.
 *
 * Returns the full description (no truncation) plus name, ref, version, and
 * source. For the actual instructions, the caller follows up with
 * `load_skill(ref)` — describe is the pre-load inspection step that fits the
 * "do I want this?" decision without the cost of pulling the body into chat.
 */
export function createDescribeSkillTool(logger: Logger): AtlasTools {
  return {
    describe_skill: tool({
      description:
        "Return the full description, ref, latest version, and source for a single skill. " +
        "Use this after list_skills or search_skills when you need more than the one-line " +
        "summary to decide whether to load. For the actual skill instructions, follow with " +
        "load_skill(ref) — describe is the cheaper inspection step.",
      inputSchema: DescribeSkillInput,
      execute: async ({ ref }): Promise<DescribeSkillSuccess | SkillToolError> => {
        let namespace: string;
        let name: string;
        try {
          const parsed = parseSkillRef(ref);
          namespace = parsed.namespace;
          name = parsed.name;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn("describe_skill: invalid ref", { ref, error: message });
          return { ok: false, error: `Invalid skill reference: ${message}` };
        }

        const result = await SkillStorage.get(namespace, name);
        if (!result.ok) {
          logger.warn("describe_skill: lookup failed", { ref, error: result.error });
          return { ok: false, error: result.error };
        }
        if (!result.data) {
          return { ok: false, error: `Skill "${ref}" not found in the global catalog.` };
        }
        const skill = result.data;
        const out: DescribeSkillSuccess = {
          ok: true,
          ref,
          namespace: skill.namespace,
          name: skill.name ?? name,
          description: skill.description,
          latestVersion: skill.version,
        };
        const source = skill.frontmatter.source;
        if (typeof source === "string") out.source = source;
        logger.info("describe_skill succeeded", { ref, version: skill.version });
        return out;
      },
    }),
  };
}

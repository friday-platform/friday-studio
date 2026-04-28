import { Buffer } from "node:buffer";
import { parseSkillRef } from "@atlas/config";
import { logger } from "@atlas/logger";
import { type Tool, tool } from "ai";
import { z } from "zod";
import { extractArchiveContents } from "./archive.ts";
import { resolveVisibleSkills } from "./resolve.ts";
import { type LintFinding, lintCache, lintSkill } from "./skill-linter.ts";
import { SkillStorage } from "./storage.ts";

const LoadSkillInputSchema = z.object({
  name: z.string().describe("Skill name from <available_skills>"),
  reason: z.string().optional().describe("Why are you loading this skill?"),
});

/**
 * Hardcoded skill definition for bundled skills that don't require database lookup.
 */
export interface HardcodedSkill {
  id: string;
  description: string;
  instructions: string;
}

export interface CreateLoadSkillToolOptions {
  /**
   * Hardcoded skills that take precedence over all other sources.
   * Checked first (tier 1).
   */
  hardcodedSkills?: readonly HardcodedSkill[];

  /**
   * When set, the tool refuses to load any catalog skill that is not in the
   * visible set for this workspace (optionally narrowed to `jobName` — see
   * below). Visibility is computed via `resolveVisibleSkills` so the tool
   * and prompt see the *same* set — invariant enforced by
   * `tests/drift-invariant.test.ts`.
   *
   * This is defense in depth: the agent's prompt should already only list
   * resolved skills, but a hallucinated or injected skill name shouldn't be
   * able to bypass scoping just because it doesn't appear in <available_skills>.
   */
  workspaceId?: string;

  /**
   * When set (alongside `workspaceId`), job-level assigned skills become
   * visible in addition to workspace-level + global. Without `jobName`,
   * only workspace-level and global skills are visible — job-level rows
   * assigned to some *other* job in the same workspace would be blocked.
   */
  jobName?: string;

  /**
   * Per-job-step skill filter — Phase 7 of the skills-scoping plan.
   *
   * Array of `@namespace/name` refs permitted for the current FSM job step
   * (in addition to any hardcoded skills passed above, which are always
   * allowed). An empty array means "no workspace skills for this step".
   * `null` / `undefined` means "no filter, inherit workspace visibility".
   *
   * When set, both the tool's `description` (the list of built-in skill IDs
   * the LLM is told about) and the load-time check drop skills the step
   * isn't authorized for.
   */
  jobFilter?: readonly string[] | null;
}

export interface LoadSkillToolResult {
  tool: Tool;
  /** Clears the in-memory skill archive cache. Call when the session ends. */
  cleanup: () => Promise<void>;
}

/**
 * Creates a load_skill tool with two-tier resolution:
 *   1. Hardcoded skills (conversation agent's bundled skills)
 *   2. Global catalog
 *
 * When `workspaceId` is set, catalog lookups enforce assignment-based
 * scoping (defense in depth on top of the upstream prompt filtering).
 *
 * Returns `{ tool, cleanup }`. Call `cleanup()` when the session ends to
 * remove extracted skill archive directories.
 */
export function createLoadSkillTool(options: CreateLoadSkillToolOptions = {}): LoadSkillToolResult {
  const { hardcodedSkills = [], workspaceId, jobName, jobFilter } = options;
  const jobFilterSet = jobFilter ? new Set(jobFilter) : null;

  // `@friday/*` skills are the system library — always visible, regardless
  // of the step's `skills: [...]` filter, because they're the cross-step
  // "how to author skills" / "how to create workspaces" utilities.
  function isAllowedByJobFilter(ref: string): boolean {
    if (!jobFilterSet) return true;
    if (ref.startsWith("@friday/")) return true;
    return jobFilterSet.has(ref);
  }

  // Hardcoded skills bypass the filter — they're owned by the calling agent
  // (e.g. conversation), not by the workspace skill catalog.
  const hardcodedIds = hardcodedSkills.map((s) => s.id);

  // Cache extracted reference file contents by "skillId:version" to avoid re-extracting
  const referenceFilesCache = new Map<string, Record<string, string>>();

  const baseInstruction =
    "Load skill instructions BEFORE starting a task that matches a skill's description. " +
    "Skills contain step-by-step guidance you should follow. " +
    "Check <available_skills> - if your task matches, load the skill first.";

  const filterSuffix = jobFilter
    ? ` (filtered for this step: ${[...jobFilter].join(", ") || "@friday/* only"})`
    : "";

  const description =
    hardcodedSkills.length > 0
      ? `${baseInstruction} Built-in skills: ${hardcodedIds.join(
          ", ",
        )}. Workspace skills also available${filterSuffix}.`
      : jobFilter
        ? `${baseInstruction} Workspace skills${filterSuffix}.`
        : baseInstruction;

  const skillTool = tool({
    description,
    inputSchema: LoadSkillInputSchema,
    execute: async ({ name, reason }) => {
      logger.info("skill_load_requested", { skill: name, reason });

      // Tier 1: Hardcoded skills
      const hardcoded = hardcodedSkills.find((s) => s.id === name);
      if (hardcoded) {
        logger.info("skill_loaded", { skill: name, source: "hardcoded", reason });
        return {
          name: hardcoded.id,
          description: hardcoded.description,
          instructions: hardcoded.instructions,
        };
      }

      // Tier 2: Global catalog
      if (name.startsWith("@") && name.includes("/")) {
        if (!isAllowedByJobFilter(name)) {
          logger.warn("skill_blocked_by_job_filter", {
            skill: name,
            jobFilter: [...(jobFilter ?? [])],
          });
          return { error: `Skill "${name}" is not allowed for this job step.` };
        }
        return await resolveGlobalSkill(name, referenceFilesCache, workspaceId, jobName);
      }

      const sources = [hardcodedSkills.length > 0 ? "built-in" : null, "global catalog"]
        .filter(Boolean)
        .join(", ");

      logger.warn("skill_not_found", { skill: name });
      return { error: `Skill "${name}" not found. Check ${sources} in <available_skills>.` };
    },
  });

  async function cleanup(): Promise<void> {
    referenceFilesCache.clear();
  }

  return { tool: skillTool, cleanup };
}

async function resolveGlobalSkill(
  ref: string,
  referenceFilesCache: Map<string, Record<string, string>>,
  workspaceId?: string,
  jobName?: string,
): Promise<
  | {
      name: string;
      description: string;
      instructions: string;
      frontmatter?: Record<string, unknown>;
      referenceFiles?: Record<string, string>;
      lintWarnings?: LintFinding[];
    }
  | { error: string }
> {
  let namespace: string;
  let skillName: string;
  try {
    const parsed = parseSkillRef(ref);
    namespace = parsed.namespace;
    skillName = parsed.name;
  } catch {
    return { error: `Invalid skill reference "${ref}". Expected @namespace/skill-name format.` };
  }

  const result = await SkillStorage.get(namespace, skillName);
  if (!result.ok) {
    logger.warn("skill_load_failed", { skill: ref, error: result.error });
    return { error: result.error };
  }

  if (!result.data) {
    logger.warn("skill_not_found", { skill: ref });
    return { error: `skill ${ref} not found` };
  }

  // Defense in depth: enforce workspace + job scoping at load time. The
  // prompt filter is the primary gate, but a hallucinated/injected skill
  // name shouldn't be able to slip through. Using resolveVisibleSkills
  // guarantees the tool sees the *exact* same set as <available_skills>
  // in the prompt — the drift invariant in
  // `tests/drift-invariant.test.ts` locks this down.
  if (workspaceId) {
    const visible = await resolveVisibleSkills(workspaceId, SkillStorage, { jobName });
    const visibleIds = new Set(visible.map((s) => s.skillId));
    if (!visibleIds.has(result.data.skillId)) {
      logger.warn("skill_not_visible", { skill: ref, workspaceId, jobName });
      return {
        error: jobName
          ? `Skill "${ref}" is not available in this job.`
          : `Skill "${ref}" is not available in this workspace.`,
      };
    }
  }

  const skill = result.data;
  let { instructions } = skill;
  let referenceFiles: Record<string, string> | undefined;

  if (skill.archive) {
    const cacheKey = `${skill.skillId}:${skill.version}`;
    const cached = referenceFilesCache.get(cacheKey);
    if (cached) {
      referenceFiles = cached;
      logger.info("skill_archive_cache_hit", { skill: ref, version: skill.version });
    } else {
      const allFiles = await extractArchiveContents(Buffer.from(skill.archive));
      // Exclude SKILL.md — its content is already in instructions
      referenceFiles = Object.fromEntries(
        Object.entries(allFiles).filter(([k]) => k !== "SKILL.md" && k !== "./SKILL.md"),
      );
      referenceFilesCache.set(cacheKey, referenceFiles);
    }
    // Legacy compat: strip $SKILL_DIR/ prefix so instructions use relative paths
    instructions = instructions.replaceAll("$SKILL_DIR/", "");
  }

  logger.info("skill_loaded", {
    skill: ref,
    source: "global",
    version: skill.version,
    hasArchive: !!skill.archive,
  });

  // Load-time fast-pass lint: cached by skillId:version, invalidated
  // automatically because version bumps on every publish / file-PUT.
  let lintResult = lintCache.get(skill.skillId, skill.version);
  if (!lintResult) {
    lintResult = lintSkill(
      {
        name: skill.name ?? skillName,
        frontmatter: skill.frontmatter,
        instructions: skill.instructions,
      },
      "load",
    );
    lintCache.set(skill.skillId, skill.version, lintResult);
  }

  const response: {
    name: string;
    description: string;
    instructions: string;
    frontmatter?: Record<string, unknown>;
    referenceFiles?: Record<string, string>;
    lintWarnings?: LintFinding[];
  } = { name: skill.name ?? skillName, description: skill.description, instructions };

  if (Object.keys(skill.frontmatter).length > 0) {
    response.frontmatter = skill.frontmatter;
  }

  if (referenceFiles && Object.keys(referenceFiles).length > 0) {
    response.referenceFiles = referenceFiles;
  }

  if (lintResult.warnings.length > 0) {
    response.lintWarnings = lintResult.warnings;
  }

  return response;
}

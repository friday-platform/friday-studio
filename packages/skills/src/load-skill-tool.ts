import { Buffer } from "node:buffer";
import { rm } from "node:fs/promises";
import { parseSkillRef } from "@atlas/config";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { type Tool, tool } from "ai";
import { z } from "zod";
import { extractSkillArchive, injectSkillDir } from "./archive.ts";
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
   * When set, the tool refuses to load any catalog skill that is assigned
   * to a different workspace. Skills with no assignments (global) and skills
   * assigned to this workspace are allowed.
   *
   * This is defense in depth: the agent's prompt should already only list
   * resolved skills, but a hallucinated or injected skill name shouldn't be
   * able to bypass scoping just because it doesn't appear in <available_skills>.
   */
  workspaceId?: string;
}

export interface LoadSkillToolResult {
  tool: Tool;
  /** Removes all extracted skill directories. Call when the session ends. */
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
  const { hardcodedSkills = [], workspaceId } = options;
  const hardcodedIds = hardcodedSkills.map((s) => s.id);

  // Cache extracted skill dirs by "namespace/name/version" to avoid re-extracting
  const extractedDirs = new Map<string, string>();

  const baseInstruction =
    "Load skill instructions BEFORE starting a task that matches a skill's description. " +
    "Skills contain step-by-step guidance you should follow. " +
    "Check <available_skills> - if your task matches, load the skill first.";

  const description =
    hardcodedSkills.length > 0
      ? `${baseInstruction} Built-in skills: ${hardcodedIds.join(
          ", ",
        )}. Workspace skills also available.`
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
        return await resolveGlobalSkill(name, extractedDirs, workspaceId);
      }

      const sources = [hardcodedSkills.length > 0 ? "built-in" : null, "global catalog"]
        .filter(Boolean)
        .join(", ");

      logger.warn("skill_not_found", { skill: name });
      return { error: `Skill "${name}" not found. Check ${sources} in <available_skills>.` };
    },
  });

  async function cleanup(): Promise<void> {
    const dirs = [...extractedDirs.values()];
    extractedDirs.clear();
    await Promise.all(
      dirs.map((dir) =>
        rm(dir, { recursive: true, force: true }).catch((e) =>
          logger.debug("cleanup failed", { error: stringifyError(e), dir }),
        ),
      ),
    );
  }

  return { tool: skillTool, cleanup };
}

async function resolveGlobalSkill(
  ref: string,
  extractedDirs: Map<string, string>,
  workspaceId?: string,
): Promise<
  | {
      name: string;
      description: string;
      instructions: string;
      frontmatter?: Record<string, unknown>;
      skillDir?: string;
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

  // Defense in depth: enforce workspace scoping at load time too. The prompt
  // filter is the primary gate, but a hallucinated/injected skill name
  // shouldn't be able to slip through just because it bypasses the prompt.
  if (workspaceId) {
    const assignments = await SkillStorage.listAssignments(result.data.skillId);
    if (assignments.ok && assignments.data.length > 0 && !assignments.data.includes(workspaceId)) {
      logger.warn("skill_not_visible", { skill: ref, workspaceId });
      return { error: `Skill "${ref}" is not available in this workspace` };
    }
  }

  const skill = result.data;
  let { instructions } = skill;
  let skillDir: string | undefined;

  if (skill.archive) {
    const cacheKey = `${namespace}/${skillName}/${skill.version}`;
    const cached = extractedDirs.get(cacheKey);
    if (cached) {
      skillDir = cached;
      logger.info("skill_archive_cache_hit", { skill: ref, version: skill.version });
    } else {
      skillDir = await extractSkillArchive(
        Buffer.from(skill.archive),
        `atlas-skill-${namespace}-${skillName}-`,
      );
      extractedDirs.set(cacheKey, skillDir);
    }
    // Legacy compat: replace $SKILL_DIR with actual path for old skills.
    // New skills use relative paths and don't need this.
    instructions = injectSkillDir(instructions, skillDir);
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
    skillDir?: string;
    lintWarnings?: LintFinding[];
  } = { name: skill.name ?? skillName, description: skill.description, instructions };

  if (Object.keys(skill.frontmatter).length > 0) {
    response.frontmatter = skill.frontmatter;
  }

  if (skillDir) {
    response.skillDir = skillDir;
  }

  if (lintResult.warnings.length > 0) {
    response.lintWarnings = lintResult.warnings;
  }

  return response;
}

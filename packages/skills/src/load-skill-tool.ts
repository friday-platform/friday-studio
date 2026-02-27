import { Buffer } from "node:buffer";
import { rm } from "node:fs/promises";
import type { GlobalSkillRefConfig, InlineSkillConfig } from "@atlas/config";
import { parseSkillRef } from "@atlas/config";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { type Tool, tool } from "ai";
import { z } from "zod";
import { extractSkillArchive, injectSkillDir } from "./archive.ts";
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
   * Inline skills from workspace config (in-memory only).
   * Checked second (tier 2).
   */
  inlineSkills?: readonly InlineSkillConfig[];

  /**
   * Global skill references from workspace config, used for version pinning.
   * When a global skill ref has `version`, that exact version is fetched.
   * Otherwise, latest is resolved.
   */
  skillEntries?: readonly GlobalSkillRefConfig[];
}

export interface LoadSkillToolResult {
  tool: Tool;
  /** Removes all extracted skill directories. Call when the session ends. */
  cleanup: () => Promise<void>;
}

/**
 * Creates a load_skill tool with three-tier resolution:
 *   1. Hardcoded skills (conversation agent's bundled skills)
 *   2. Inline skills (workspace config, in-memory)
 *   3. Global catalog (SkillStorage.get with namespace/name/version)
 *
 * Returns `{ tool, cleanup }`. Call `cleanup()` when the session ends to
 * remove extracted skill archive directories.
 */
export function createLoadSkillTool(options: CreateLoadSkillToolOptions = {}): LoadSkillToolResult {
  const { hardcodedSkills = [], inlineSkills = [], skillEntries = [] } = options;
  const hardcodedIds = hardcodedSkills.map((s) => s.id);

  const versionMap = new Map<string, number | undefined>();
  for (const entry of skillEntries) {
    versionMap.set(entry.name, entry.version);
  }

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

      // Tier 2: Inline skills from workspace config
      const inline = inlineSkills.find((s) => s.name === name);
      if (inline) {
        logger.info("skill_loaded", { skill: name, source: "inline", reason });
        return {
          name: inline.name,
          description: inline.description,
          instructions: inline.instructions,
        };
      }

      // Tier 3: Global catalog
      if (name.startsWith("@") && name.includes("/")) {
        return await resolveGlobalSkill(name, versionMap, extractedDirs);
      }

      const sources = [
        hardcodedSkills.length > 0 ? "built-in" : null,
        inlineSkills.length > 0 ? "inline" : null,
        "global catalog",
      ]
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
  versionMap: Map<string, number | undefined>,
  extractedDirs: Map<string, string>,
): Promise<
  | {
      name: string;
      description: string;
      instructions: string;
      frontmatter?: Record<string, unknown>;
      skillDir?: string;
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

  const pinnedVersion = versionMap.get(ref);

  const result = await SkillStorage.get(namespace, skillName, pinnedVersion);
  if (!result.ok) {
    logger.warn("skill_load_failed", { skill: ref, error: result.error });
    return { error: result.error };
  }

  if (!result.data) {
    const versionStr = pinnedVersion ? ` version ${pinnedVersion}` : "";
    logger.warn("skill_not_found", { skill: ref, version: pinnedVersion });
    return { error: `skill ${ref}${versionStr} not found` };
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
    instructions = injectSkillDir(instructions, skillDir);
  }

  logger.info("skill_loaded", {
    skill: ref,
    source: "global",
    version: skill.version,
    hasArchive: !!skill.archive,
  });

  const response: {
    name: string;
    description: string;
    instructions: string;
    frontmatter?: Record<string, unknown>;
    skillDir?: string;
  } = { name: skill.name ?? skillName, description: skill.description, instructions };

  if (Object.keys(skill.frontmatter).length > 0) {
    response.frontmatter = skill.frontmatter;
  }

  if (skillDir) {
    response.skillDir = skillDir;
  }

  return response;
}

/**
 * Skill discovery orchestrator for the global chat.
 *
 * Flow: complexity judgment (single LLM call) → local skill search →
 * skills.sh fallback → download → validate → publish → return resolved name.
 *
 * @module
 */

import { smallLLM } from "@atlas/llm";
import { createLogger } from "@atlas/logger";
import {
  parseSkillMd,
  SkillStorage,
  type SkillSummary,
  type SkillsShClient,
  type SkillsShSkillEntry,
} from "@atlas/skills";
import { z } from "zod";

const logger = createLogger({ name: "chat-skill-discovery" });

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const ComplexityJudgmentSchema = z.object({
  complex: z.boolean(),
  rationale: z.string().max(50),
});

export type ComplexityJudgment = z.infer<typeof ComplexityJudgmentSchema>;

// ─── Result types ────────────────────────────────────────────────────────────

export interface SkillDiscoveryResult {
  /** Whether the request was judged complex enough to warrant skill search. */
  complex: boolean;
  /** The installed skill name if one was found and installed. */
  installedSkillName: string | null;
  /** The namespace of the installed skill. */
  installedSkillNamespace: string | null;
  /** Where the skill came from: "local" | "skills.sh" | null */
  source: "local" | "skills.sh" | null;
  /** Brief rationale from the complexity judgment. */
  rationale: string;
}

// ─── Complexity judgment ─────────────────────────────────────────────────────

const COMPLEXITY_SYSTEM_PROMPT = `You are a request complexity classifier. Given a user message, determine if it would benefit from a specialized skill/tool (e.g. "build a feature", "debug this", "QA this app", "deploy to production") versus a simple conversational answer (e.g. "what is X?", "hello", "thanks").

Reply with exactly one line: YES or NO, followed by a 3-word rationale.
Examples:
- "YES needs build tooling"
- "NO simple question"
- "YES requires debugging"
- "NO greeting only"`;

/**
 * Judge whether a user message is complex enough to warrant skill discovery.
 * Returns { complex: boolean, rationale: string }.
 *
 * On LLM failure, defaults to { complex: false } to avoid blocking.
 */
export async function judgeComplexity(
  messageText: string,
  platformModels: import("@atlas/llm").PlatformModels,
): Promise<ComplexityJudgment> {
  try {
    const response = await smallLLM({
      platformModels,
      system: COMPLEXITY_SYSTEM_PROMPT,
      prompt: messageText,
      maxOutputTokens: 30,
    });

    const trimmed = response.trim();
    const isComplex = trimmed.toUpperCase().startsWith("YES");
    const rationale = trimmed.replace(/^(YES|NO)\s*/i, "").slice(0, 50);

    return { complex: isComplex, rationale };
  } catch (error) {
    logger.warn("Complexity judgment failed, defaulting to non-complex", { error });
    return { complex: false, rationale: "judgment failed" };
  }
}

// ─── Local skill search ──────────────────────────────────────────────────────

/**
 * Search locally-installed skills for a match.
 * Returns the first matching skill summary, or null.
 */
async function searchLocalSkills(messageText: string): Promise<SkillSummary | null> {
  const result = await SkillStorage.list(undefined, messageText);
  if (!result.ok || result.data.length === 0) return null;

  // The list endpoint does LIKE matching on name+description.
  // Return the first (best) match if it exists.
  const first = result.data[0];
  return first ?? null;
}

// ─── skills.sh search + install ──────────────────────────────────────────────

/**
 * Parse the source field from a skills.sh entry into owner/repo/slug components.
 * Expected format: "owner/repo" or "owner/repo/slug" or similar.
 */
function parseSkillSource(
  entry: SkillsShSkillEntry,
): { owner: string; repo: string; slug: string } | null {
  const parts = entry.source.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1];
  const slug = entry.name || parts[2] || entry.id;
  if (!owner || !repo) return null;
  return { owner, repo, slug };
}

/**
 * Download a skill from skills.sh, validate its frontmatter, and publish
 * it locally via SkillStorage.
 *
 * Returns the installed skill name on success, or null on failure.
 */
async function downloadAndInstallSkill(
  client: SkillsShClient,
  entry: SkillsShSkillEntry,
): Promise<{ namespace: string; name: string } | null> {
  const parsed = parseSkillSource(entry);
  if (!parsed) {
    logger.warn("Could not parse skill source for download", { source: entry.source });
    return null;
  }

  try {
    const downloadResult = await client.download(parsed.owner, parsed.repo, parsed.slug);

    // Find SKILL.md in the downloaded files
    const skillMdFile = downloadResult.files.find(
      (f) => f.path === "SKILL.md" || f.path.endsWith("/SKILL.md"),
    );

    if (!skillMdFile) {
      logger.warn("Downloaded skill has no SKILL.md", { source: entry.source });
      return null;
    }

    // Validate frontmatter
    const parseResult = parseSkillMd(skillMdFile.contents);
    if (!parseResult.ok) {
      logger.warn("Downloaded skill has invalid SKILL.md", {
        source: entry.source,
        error: parseResult.error,
      });
      return null;
    }

    const { frontmatter, instructions } = parseResult.data;
    const skillName =
      entry.name || (typeof frontmatter.name === "string" ? frontmatter.name : parsed.slug);
    const namespace = parsed.owner;
    const description =
      typeof frontmatter.description === "string"
        ? frontmatter.description
        : `Skill from skills.sh: ${entry.name}`;

    // Publish via SkillStorage
    const publishResult = await SkillStorage.publish(namespace, skillName, "skills-sh-auto", {
      instructions,
      frontmatter,
      description,
    });

    if (!publishResult.ok) {
      logger.warn("Failed to publish skill from skills.sh", {
        source: entry.source,
        error: publishResult.error,
      });
      return null;
    }

    logger.info("Installed skill from skills.sh", {
      namespace,
      name: skillName,
      version: publishResult.data.version,
    });

    return { namespace, name: skillName };
  } catch (error) {
    logger.warn("skills.sh download/install failed", { source: entry.source, error });
    return null;
  }
}

// ─── Main orchestrator ───────────────────────────────────────────────────────

export interface DiscoverSkillOptions {
  /** The user's message text. */
  messageText: string;
  /** Workspace ID for local skill search scope. */
  workspaceId: string;
  /** skills.sh client instance (injected for testability). */
  skillsShClient: SkillsShClient;
  /** Platform LLM resolver (classifier role used for the complexity judgment). */
  platformModels: import("@atlas/llm").PlatformModels;
}

/**
 * Full skill discovery flow:
 * 1. Complexity judgment (single LLM call)
 * 2. If complex → local skill search
 * 3. If no local match → skills.sh search + download + install
 * 4. Return result
 */
export async function discoverAndInstallSkill(
  options: DiscoverSkillOptions,
): Promise<SkillDiscoveryResult> {
  const { messageText, skillsShClient, platformModels } = options;

  // Step 1: Complexity judgment
  const judgment = await judgeComplexity(messageText, platformModels);

  if (!judgment.complex) {
    logger.debug("Skill discovery skipped: not complex", { rationale: judgment.rationale });
    return {
      complex: false,
      installedSkillName: null,
      installedSkillNamespace: null,
      source: null,
      rationale: judgment.rationale,
    };
  }

  // Step 2: Local skill search
  const localMatch = await searchLocalSkills(messageText);
  if (localMatch && localMatch.name) {
    logger.info("Found local skill match", { skillId: localMatch.skillId, name: localMatch.name });
    return {
      complex: true,
      installedSkillName: localMatch.name,
      installedSkillNamespace: localMatch.namespace,
      source: "local",
      rationale: judgment.rationale,
    };
  }

  // Step 3: skills.sh search
  try {
    const searchResult = await skillsShClient.search(messageText, 10);

    if (searchResult.skills.length === 0) {
      logger.debug("No skills found on skills.sh", { query: messageText });
      return {
        complex: true,
        installedSkillName: null,
        installedSkillNamespace: null,
        source: null,
        rationale: judgment.rationale,
      };
    }

    // Pick the top result (already sorted by official priority)
    const topEntry = searchResult.skills[0];
    if (!topEntry) {
      return {
        complex: true,
        installedSkillName: null,
        installedSkillNamespace: null,
        source: null,
        rationale: judgment.rationale,
      };
    }

    // Step 4: Download and install
    const installed = await downloadAndInstallSkill(skillsShClient, topEntry);
    if (!installed) {
      return {
        complex: true,
        installedSkillName: null,
        installedSkillNamespace: null,
        source: null,
        rationale: judgment.rationale,
      };
    }

    return {
      complex: true,
      installedSkillName: installed.name,
      installedSkillNamespace: installed.namespace,
      source: "skills.sh",
      rationale: judgment.rationale,
    };
  } catch (error) {
    logger.warn("skills.sh search/install failed", { error });
    return {
      complex: true,
      installedSkillName: null,
      installedSkillNamespace: null,
      source: null,
      rationale: judgment.rationale,
    };
  }
}

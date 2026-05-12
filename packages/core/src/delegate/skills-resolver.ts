/**
 * Resolves the `skills` arg the parent passes to `delegate` into ready-to-inject
 * text for the child's system prompt.
 *
 * Authority: the parent's *visible* skill set (workspace-level + global, plus
 * job-level when applicable) — same gate `load_skill` enforces. Anything
 * outside that set is dropped + logged; the child never sees a skill the
 * parent itself couldn't load.
 *
 * Granularity: each request is `{ name, refs? }`. With no `refs`, the skill's
 * SKILL.md body lands in the child's prompt. With `refs`, only the listed
 * reference files do — the surgical path that keeps the child prompt small
 * when the parent knows exactly which section is relevant.
 */

import { parseSkillRef } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import {
  extractArchiveContents,
  resolveVisibleSkills,
  SkillStorage,
  type SkillSummary,
} from "@atlas/skills";

export interface DelegateSkillRequest {
  name: string;
  refs?: readonly string[];
}

export interface ResolvedDelegateSkill {
  name: string;
  description: string;
  /**
   * Pre-formatted body — either the SKILL.md instructions, or one `<file
   * path="…">…</file>` block per requested ref. Already trimmed and joined.
   */
  body: string;
}

/**
 * Cache of extracted skill archives keyed by `${skillId}:${version}`. Owned by
 * the caller (typically `createDelegateTool`'s closure) so its lifetime
 * matches the parent agent's session. Promise-valued so concurrent requests
 * for the same skill share the in-flight extraction instead of double-untar.
 * Mirrors `load-skill-tool.ts`'s `referenceFilesCache`.
 */
export type SkillArchiveCache = Map<string, Promise<Record<string, string>>>;

export interface ResolveDelegateSkillsDeps {
  workspaceId: string;
  /** Optional job scope — narrows visibility the same way the agent loader does. */
  jobName?: string;
  logger: Logger;
  /** Optional per-session archive cache. When omitted, every refs request re-extracts. */
  archiveCache?: SkillArchiveCache;
}

export async function resolveDelegateSkills(
  requested: readonly DelegateSkillRequest[],
  deps: ResolveDelegateSkillsDeps,
): Promise<ResolvedDelegateSkill[]> {
  if (requested.length === 0) return [];

  const { workspaceId, jobName, archiveCache } = deps;
  const visible = await resolveVisibleSkills(workspaceId, SkillStorage, { jobName });
  // Plain string keys — `s.name` can be `null` per the schema, which would
  // narrow the inferred Map key type to a template-literal union and reject
  // the `requested` arg's `string` shape on `.has()`.
  const visibleByRef = new Map<string, SkillSummary>(
    visible.map((s) => [`@${s.namespace}/${s.name}`, s]),
  );

  // Resolve all requested skills in parallel. Each call hits SkillStorage.get
  // (a JetStream KV read) and may extract a tarball — both are independent
  // across skills, so serial awaits left wall-clock latency on the table.
  const settled = await Promise.all(
    requested.map((req) => resolveOne(req, visibleByRef, deps, archiveCache)),
  );
  return settled.filter((r): r is ResolvedDelegateSkill => r !== null);
}

async function resolveOne(
  request: DelegateSkillRequest,
  visibleByRef: Map<string, SkillSummary>,
  deps: ResolveDelegateSkillsDeps,
  archiveCache: SkillArchiveCache | undefined,
): Promise<ResolvedDelegateSkill | null> {
  const { name, refs } = request;
  const { workspaceId, jobName, logger } = deps;

  if (!visibleByRef.has(name)) {
    logger.warn("delegate_skill_not_visible", { skill: name, workspaceId, jobName });
    return null;
  }

  let namespace: string;
  let skillName: string;
  try {
    const parsed = parseSkillRef(name);
    namespace = parsed.namespace;
    skillName = parsed.name;
  } catch {
    logger.warn("delegate_skill_invalid_ref", { skill: name });
    return null;
  }

  const result = await SkillStorage.get(namespace, skillName);
  if (!result.ok || !result.data) {
    logger.warn("delegate_skill_load_failed", {
      skill: name,
      error: result.ok ? "not found" : result.error,
    });
    return null;
  }

  const skill = result.data;

  if (!refs || refs.length === 0) {
    return { name, description: skill.description, body: skill.instructions.trim() };
  }

  if (!skill.archive) {
    logger.warn("delegate_skill_no_archive", { skill: name, refs: [...refs] });
    return null;
  }

  // Cache key bumps on every publish (skill version is monotone), so a
  // republished skill busts the cache automatically. Promise-valued so two
  // concurrent requests for the same skill within one delegate call share
  // the extraction work instead of racing on the tempdir.
  const cacheKey = `${skill.skillId}:${skill.version}`;
  let filesPromise = archiveCache?.get(cacheKey);
  if (!filesPromise) {
    filesPromise = extractArchiveContents(skill.archive);
    archiveCache?.set(cacheKey, filesPromise);
  }

  let files: Record<string, string>;
  try {
    files = await filesPromise;
  } catch (err) {
    logger.warn("delegate_skill_archive_extract_failed", {
      skill: name,
      error: err instanceof Error ? err.message : String(err),
    });
    // A failed promise stays in the cache and would poison every future
    // request for this version. Evict so a retry has a chance to succeed.
    archiveCache?.delete(cacheKey);
    return null;
  }

  const sections: string[] = [];
  for (const ref of refs) {
    const content = files[ref];
    if (content === undefined) {
      logger.warn("delegate_skill_ref_not_found", { skill: name, ref });
      continue;
    }
    sections.push(`<file path="${ref}">\n${content.trim()}\n</file>`);
  }
  if (sections.length === 0) return null;

  return { name, description: skill.description, body: sections.join("\n\n") };
}

/**
 * Render resolved skills as a single `<skills>` XML block to prepend to the
 * child's system prompt. Empty input yields an empty string so callers can
 * splice unconditionally.
 */
export function formatDelegateSkillsBlock(resolved: readonly ResolvedDelegateSkill[]): string {
  if (resolved.length === 0) return "";
  const blocks = resolved.map((s) => `<skill name="${s.name}">\n${s.body}\n</skill>`).join("\n\n");
  return `<skills>\n${blocks}\n</skills>`;
}

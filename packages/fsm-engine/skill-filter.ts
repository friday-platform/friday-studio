/**
 * Per-action skill filter for FSM LLM/agent actions.
 *
 * Applied on top of the workspace/job skill resolution (`resolveVisibleSkills`):
 *
 *  - `allowlist` undefined → return resolved unchanged (inherit)
 *  - `allowlist` empty array → return [] (action explicitly opts out of skills)
 *  - `allowlist` populated → return only resolved skills whose name is in allowlist
 */

interface NamedSkill {
  /** Skill name. Nullable to match the SkillSummary shape from `@atlas/skills`. */
  name: string | null;
}

export function applySkillAllowlist<T extends NamedSkill>(
  resolved: readonly T[],
  allowlist: readonly string[] | undefined,
): T[] {
  if (allowlist === undefined) return [...resolved];
  if (allowlist.length === 0) return [];
  const allowed = new Set(allowlist);
  return resolved.filter((s) => s.name !== null && allowed.has(s.name));
}

/** Returns the names from `allowlist` that are not present in `resolved`. */
export function unmatchedAllowlistEntries<T extends NamedSkill>(
  resolved: readonly T[],
  allowlist: readonly string[] | undefined,
): string[] {
  if (allowlist === undefined || allowlist.length === 0) return [];
  const have = new Set(resolved.map((s) => s.name).filter((n): n is string => n !== null));
  return allowlist.filter((s) => !have.has(s));
}

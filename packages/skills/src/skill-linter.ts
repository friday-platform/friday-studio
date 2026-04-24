/**
 * Skill linter — shared rule set with two entry points (publish + load-time).
 *
 * Rules pulled from:
 *   - https://agentskills.io/skill-creation/best-practices
 *   - https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices
 *
 * Publish-time runs the full set (including reference-depth walks);
 * load-time runs a fast pass (frontmatter + budgets only) and is cached
 * by `skillId:version` to keep every `load_skill` invocation cheap.
 *
 * @module
 */

import { RESERVED_WORDS } from "@atlas/config";
import { validateSkillReferences } from "./archive.ts";
import { SkillFrontmatterSchema } from "./skill-md-parser.ts";

// ─── Types ──────────────────────────────────────────────────────────────────

export type LintSeverity = "info" | "warn" | "error";

export interface LintFinding {
  rule: string;
  message: string;
  severity: LintSeverity;
}

export interface LintResult {
  warnings: LintFinding[];
  errors: LintFinding[];
}

/** Input to {@link lintSkill}. Everything except `mode` is optional. */
export interface LintInput {
  /** Parsed SKILL.md frontmatter (see `SkillFrontmatterSchema`). */
  frontmatter: Record<string, unknown>;
  /** SKILL.md body (everything after the frontmatter block). */
  instructions: string;
  /** `name` part of the skill ref (e.g. "processing-pdfs"). */
  name: string;
  /**
   * Archive file paths relative to the skill root
   * (e.g. `["references/api.md", "scripts/lint.py"]`). Required for
   * publish-mode reference-depth + broken-link checks; omitted for
   * load-mode (fast pass).
   */
  archiveFiles?: string[];
  /**
   * Contents of archive text files keyed by relative path. When provided,
   * reference-depth checks can walk one level deep. Publish-time only.
   */
  archiveContents?: Record<string, string>;
  /**
   * Set of tool names known to the platform. When provided, validates
   * `allowed-tools` entries against it. When null/undefined, the check
   * is skipped (forward-compat with platforms that don't expose the
   * registry, e.g. skills.sh imports).
   */
  knownTools?: ReadonlySet<string> | null;
}

export type LintMode =
  /** Fast pass: frontmatter + body budgets only. No disk I/O. */
  | "load"
  /** Full pass: all rules. Requires `archiveFiles` for reference checks. */
  | "publish";

// ─── Thresholds ─────────────────────────────────────────────────────────────

export const BODY_WARN_LINES = 500;
const BODY_ERR_LINES = 800;
const BODY_WARN_TOKENS = 5000;
const BODY_ERR_TOKENS = 8000;

/** References longer than this without a `## Contents` TOC produce a warning. */
const REF_WARN_LINES = 100;

// ─── Patterns ───────────────────────────────────────────────────────────────

// Kebab-case, 1–64 chars, matches agentskills.io spec.
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// First/second-person openings that break router discovery.
const FIRST_PERSON_RE =
  /\b(I\s+(?:can|will|help|am)|you\s+(?:can|will|should|may)|this\s+skill\s+is)\b/i;

// Month-year phrases like "Before August 2025" inside prose (not fenced code).
const TIME_SENSITIVE_RE = /\b(?:before|after|until|by)\s+[A-Za-z]+\s+\d{4}\b/i;

// Windows-style paths between identifier-like segments with a known ext.
const BACKSLASH_PATH_RE =
  /[A-Za-z_][A-Za-z0-9_]*\\[A-Za-z_][A-Za-z0-9_\\]*\.(?:md|py|sh|json|yaml|yml|js|ts|txt)\b/;

// ─── Helpers ────────────────────────────────────────────────────────────────

const INLINE_CODE_RE = /`[^`]*`/g;
const FENCED_CODE_RE = /```[\s\S]*?```/g;

/** Remove fenced + inline code so anti-example snippets don't trip style checks. */
function stripCode(text: string): string {
  return text.replaceAll(FENCED_CODE_RE, "").replaceAll(INLINE_CODE_RE, "");
}

/** Rough token estimate — ~4 chars per token, consistent across providers. */
function estimateTokens(text: string): number {
  return Math.max(1, Math.floor(text.length / 4));
}

function splitAllowedTools(raw: unknown): string[] | null {
  if (typeof raw !== "string") return null;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    // Strip a trailing `(…)` argument qualifier — "Bash(rm:*)" normalizes to "Bash".
    // This matches how the platform's tool-permission parser treats the prefix.
    .map((s) => s.replace(/\(.*\)$/, "").trim())
    .filter((s) => s.length > 0);
  return parts;
}

// ─── Main entry ─────────────────────────────────────────────────────────────

/**
 * Lint a skill in either `load` (fast) or `publish` (full) mode.
 *
 * Returns findings grouped by severity. Errors block publish; warnings
 * are informational and get surfaced in the Context tab via the
 * `skill-lint-warning` data event.
 *
 * No exceptions — every rule that cannot run silently no-ops. This
 * keeps load-time linting safe to embed in hot paths.
 */
export function lintSkill(input: LintInput, mode: LintMode): LintResult {
  const warnings: LintFinding[] = [];
  const errors: LintFinding[] = [];

  function warn(rule: string, message: string, severity: LintSeverity = "warn"): void {
    (severity === "error" ? errors : warnings).push({ rule, message, severity });
  }

  // Frontmatter schema — defensive re-parse so we don't depend on upstream validation.
  const fmResult = SkillFrontmatterSchema.safeParse(input.frontmatter);
  if (!fmResult.success) {
    errors.push({
      rule: "frontmatter-schema",
      message: `Invalid frontmatter: ${fmResult.error.message}`,
      severity: "error",
    });
  }
  const fm = fmResult.success ? fmResult.data : input.frontmatter;

  // Name rules.
  const name = input.name;
  if (!NAME_RE.test(name)) {
    warn(
      "name-pattern",
      `Name "${name}" should be lowercase kebab-case. Prefer gerund form, e.g. processing-pdfs.`,
      "warn",
    );
  }
  if (name.length > 64) {
    warn("name-length", `Name is ${name.length} chars, exceeds 64.`, "error");
  }
  for (const reserved of RESERVED_WORDS) {
    if (name.toLowerCase().includes(reserved)) {
      warn("name-reserved", `Name contains reserved substring "${reserved}".`, "error");
    }
  }

  // Description rules.
  const description = typeof fm.description === "string" ? fm.description : "";
  if (!description) {
    warn("description-missing", "Frontmatter is missing a `description` field.", "error");
  } else {
    if (description.length > 1024) {
      warn(
        "description-length",
        `Description is ${description.length} chars, exceeds 1024.`,
        "error",
      );
    }
    if (FIRST_PERSON_RE.test(description)) {
      warn(
        "description-person",
        "Description uses first/second person. Router discovery works best with third person.",
      );
    }
    if (!/\buse\b/i.test(description) && !/\bused\b/i.test(description)) {
      // Demoted to `info` after the Phase 4.a skills run showed a 75% hit
      // rate on existing skills — the "Use when …" clause is a best-practice
      // recommendation but many perfectly-useful skills ship without it.
      // See docs/learnings/2026-04-20-lint-skills-report.md.
      warn(
        "description-trigger",
        "Description should include a 'Use when …' clause so the router knows when to fire.",
        "info",
      );
    }
  }

  // Body budgets.
  const body = input.instructions;
  const lineCount = (body.match(/\n/g)?.length ?? 0) + 1;
  const tokenCount = estimateTokens(body);

  if (lineCount > BODY_ERR_LINES) {
    warn("body-lines", `SKILL.md body is ${lineCount} lines, exceeds ${BODY_ERR_LINES}.`, "error");
  } else if (lineCount > BODY_WARN_LINES) {
    warn("body-lines", `SKILL.md body is ${lineCount} lines, exceeds ${BODY_WARN_LINES}.`);
  }
  if (tokenCount > BODY_ERR_TOKENS) {
    warn(
      "body-tokens",
      `SKILL.md body is ~${tokenCount} tokens, exceeds ${BODY_ERR_TOKENS}.`,
      "error",
    );
  } else if (tokenCount > BODY_WARN_TOKENS) {
    warn("body-tokens", `SKILL.md body is ~${tokenCount} tokens, exceeds ${BODY_WARN_TOKENS}.`);
  }

  // Style checks — run against prose (code blocks stripped) so anti-example
  // snippets don't trip.
  const prose = stripCode(body);
  if (TIME_SENSITIVE_RE.test(prose)) {
    warn(
      "time-sensitive",
      "Time-sensitive phrasing found — wrap superseded content in a `<details>` Old patterns block.",
    );
  }
  if (BACKSLASH_PATH_RE.test(prose)) {
    warn(
      "path-style",
      "Windows-style path found outside code block. Use forward slashes everywhere.",
      "error",
    );
  }

  // `allowed-tools` registry check — only runs when a registry is provided.
  const allowedTools = splitAllowedTools(fm["allowed-tools"]);
  if (allowedTools !== null) {
    if (allowedTools.length === 0 && typeof fm["allowed-tools"] === "string") {
      warn("allowed-tools-empty", "`allowed-tools` field is present but empty; likely a typo.");
    }
    if (input.knownTools) {
      const unknown = allowedTools.filter((t) => !input.knownTools?.has(t));
      if (unknown.length > 0) {
        warn("allowed-tools-unknown", `Unknown tool(s) in allowed-tools: ${unknown.join(", ")}.`);
      }
    }
  }

  // Publish-only checks — disk walks + reference depth.
  if (mode === "publish" && input.archiveFiles) {
    const deadLinks = validateSkillReferences(body, input.archiveFiles);
    for (const dead of deadLinks) {
      warn("reference-broken", `SKILL.md references a missing file: ${dead}`, "error");
    }

    // Reference files >100 lines without a `## Contents` heading.
    if (input.archiveContents) {
      for (const [path, content] of Object.entries(input.archiveContents)) {
        if (!path.endsWith(".md") || path === "SKILL.md") continue;
        const refLines = (content.match(/\n/g)?.length ?? 0) + 1;
        if (refLines > REF_WARN_LINES && !/^##\s+contents/im.test(content)) {
          warn(
            "reference-toc",
            `${path} is ${refLines} lines; add a \`## Contents\` section so partial-reads still see the structure.`,
          );
        }
      }

      // Depth-1 enforcement — SKILL.md → references/* is fine, but
      // references/a.md → references/b.md is depth-2 and gets partial-read.
      for (const [path, content] of Object.entries(input.archiveContents)) {
        if (!path.endsWith(".md") || path === "SKILL.md") continue;
        const linkRefs = Array.from(content.matchAll(/\[[^\]]+\]\(([^)]+\.md)\)/g))
          .map((m) => m[1])
          .filter((ref): ref is string => ref !== undefined)
          .filter((ref) => !ref.startsWith("http") && !ref.startsWith("#"));
        if (linkRefs.length > 0) {
          warn(
            "reference-depth",
            `${path} links to ${linkRefs.join(", ")}. Keep reference depth = 1 — partial reads drop nested content.`,
          );
        }
      }
    }
  }

  return { warnings, errors };
}

// ─── Cache for load-time linting ────────────────────────────────────────────

interface CacheEntry {
  result: LintResult;
  insertedAt: number;
}

/** Bounded LRU cache keyed by `skillId:version`. Version-keyed so a new
 *  publish naturally invalidates the prior entry. */
const DEFAULT_CAPACITY = 100;

class LintCache {
  private readonly map = new Map<string, CacheEntry>();

  constructor(private readonly capacity: number) {}

  get(skillId: string, version: number): LintResult | undefined {
    const key = this.keyFor(skillId, version);
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Refresh LRU position.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.result;
  }

  set(skillId: string, version: number, result: LintResult): void {
    const key = this.keyFor(skillId, version);
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { result, insertedAt: Date.now() });
    // Evict oldest when over capacity.
    while (this.map.size > this.capacity) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
  }

  invalidate(skillId: string): void {
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(`${skillId}:`)) this.map.delete(key);
    }
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }

  private keyFor(skillId: string, version: number): string {
    return `${skillId}:${String(version)}`;
  }
}

export const lintCache = new LintCache(DEFAULT_CAPACITY);

/** Drop cached lint results for a skill. Call from publish / file-PUT / setDisabled. */
export function invalidateLintCache(skillId: string): void {
  lintCache.invalidate(skillId);
}

/**
 * Local audit for skills imported from external sources.
 *
 * Complements (and does not depend on) the undocumented
 * `add-skill.vercel.sh/audit` endpoint — that's a soft signal, this is
 * the hard gate. Critical findings block install; warnings surface in
 * the preview UI.
 *
 * Rules are a living document — see `docs/security/skill-audit-rules.md`
 * (once that page lands) for revision history + rationale.
 *
 * @module
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type AuditSeverity = "critical" | "warn";

export interface AuditFinding {
  rule: string;
  severity: AuditSeverity;
  /** Path within the skill where the match was found (e.g. "SKILL.md"). */
  path: string;
  /** 1-indexed line number of the first match. */
  line: number;
  /** Short explanation + the matched text (truncated). */
  message: string;
}

export interface AuditResult {
  critical: AuditFinding[];
  warn: AuditFinding[];
}

export interface AuditInput {
  /** Contents of SKILL.md (frontmatter already stripped, or kept — either works). */
  skillMd: string;
  /** Map of archive path → contents. */
  archiveFiles: Record<string, string>;
}

// ─── Rules ──────────────────────────────────────────────────────────────────

interface Rule {
  name: string;
  severity: AuditSeverity;
  pattern: RegExp;
  /** Short human-readable description; gets surfaced in the UI. */
  reason: string;
  /** File-path predicate. Defaults to "every file". */
  appliesTo?: (path: string) => boolean;
}

/** Prompt-injection preambles that override the host system prompt. */
const PROMPT_INJECTION: Rule = {
  name: "prompt-injection-preamble",
  severity: "critical",
  pattern:
    /\b(?:ignore\s+(?:previous|above|prior|all)\s+(?:instructions|prompts?)|you\s+are\s+now|new\s+instructions\s*[:：])/i,
  reason: "Prompt-injection preamble attempts to override host instructions.",
};

/** API key exfiltration patterns. */
const ENV_EXFIL: Rule = {
  name: "env-var-exfiltration",
  severity: "critical",
  pattern:
    /\$(?:OPENAI|ANTHROPIC|GOOGLE|GEMINI|GROQ|CORTEX|TEMPEST|ATLAS)_[A-Z_]*(?:API_KEY|SECRET|TOKEN)\b/,
  reason: "References a provider secret env var — exfiltration risk.",
};

/** Generic `FRIDAY_*_SECRET` variants not covered above. */
const FRIDAY_SECRET_EXFIL: Rule = {
  name: "env-var-exfiltration",
  severity: "critical",
  pattern: /\bFRIDAY_[A-Z_]+_(?:SECRET|TOKEN|KEY)\b/,
  reason: "References an internal secret env var — exfiltration risk.",
};

/** sudo outside fenced code blocks. */
const SUDO: Rule = {
  name: "privilege-escalation",
  severity: "critical",
  pattern: /(?:^|[\s`])sudo\s+/m,
  reason: "Invokes `sudo` — privilege escalation risk.",
  // Only scripts, not SKILL.md prose (which may legitimately discuss sudo).
  appliesTo: (path) => path.startsWith("scripts/") || path === "scripts",
};

/** Network egress from bundled scripts. Warns rather than blocks because
 *  legitimate skills (e.g. a GitHub fetcher) may curl public APIs. */
const NETWORK_EGRESS: Rule = {
  name: "network-egress",
  severity: "warn",
  pattern: /\b(?:curl|wget|fetch)\s+https?:\/\/(?!localhost|127\.0\.0\.1)[^\s'"]+/i,
  reason: "Bundled script fetches a non-localhost URL at runtime.",
  appliesTo: (path) => path.startsWith("scripts/") || /\.(?:sh|py|js|ts)$/.test(path),
};

/** Path traversal via `../../` segments. */
const PATH_TRAVERSAL_CLIMB: Rule = {
  name: "path-traversal",
  severity: "warn",
  pattern: /(?:\.\.\/){2,}/,
  reason: "Path-traversal sequence (../../..) found.",
};

/** Direct references to sensitive system files. */
const PATH_TRAVERSAL_ETC: Rule = {
  name: "path-traversal",
  severity: "warn",
  pattern: /\/etc\/(?:passwd|shadow|sudoers|ssh)\b/,
  reason: "References a sensitive system file.",
};

const RULES: readonly Rule[] = [
  PROMPT_INJECTION,
  ENV_EXFIL,
  FRIDAY_SECRET_EXFIL,
  SUDO,
  NETWORK_EGRESS,
  PATH_TRAVERSAL_CLIMB,
  PATH_TRAVERSAL_ETC,
];

// ─── Runner ────────────────────────────────────────────────────────────────

const FENCED_CODE_RE = /```[\s\S]*?```/g;

/** Strip fenced code blocks so SKILL.md's anti-example snippets don't match. */
function stripFencedCode(text: string): string {
  return text.replaceAll(FENCED_CODE_RE, (block) => "\n".repeat(block.split("\n").length - 1));
}

function findLine(text: string, match: RegExpExecArray): number {
  const preceding = text.slice(0, match.index);
  return preceding.split("\n").length;
}

function truncate(s: string, max = 120): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/**
 * Run the audit against a skill's files. Returns critical + warn buckets.
 *
 * Critical findings should block install at the /skills/install route;
 * warn findings surface in the install preview but don't stop the flow.
 */
export function localAudit(input: AuditInput): AuditResult {
  const critical: AuditFinding[] = [];
  const warn: AuditFinding[] = [];

  const all: Record<string, string> = { ...input.archiveFiles, "SKILL.md": input.skillMd };

  for (const [path, content] of Object.entries(all)) {
    // SKILL.md gets its code blocks stripped (prose = what the agent reads),
    // other files (especially scripts) are scanned as-is.
    const scanText = path === "SKILL.md" ? stripFencedCode(content) : content;

    for (const rule of RULES) {
      if (rule.appliesTo && !rule.appliesTo(path)) continue;
      const globalPattern = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
      let m: RegExpExecArray | null;
      // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration pattern.
      while ((m = globalPattern.exec(scanText)) !== null) {
        const finding: AuditFinding = {
          rule: rule.name,
          severity: rule.severity,
          path,
          line: findLine(scanText, m),
          message: `${rule.reason} Match: ${truncate(m[0])}`,
        };
        (rule.severity === "critical" ? critical : warn).push(finding);
        // Prevent infinite loops on zero-width matches.
        if (m.index === globalPattern.lastIndex) globalPattern.lastIndex += 1;
      }
    }
  }

  return { critical, warn };
}

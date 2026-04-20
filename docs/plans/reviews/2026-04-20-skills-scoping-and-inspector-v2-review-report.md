# Review Report — v2

**Plan:** `docs/plans/2026-04-20-skills-scoping-and-inspector.v2.md`
**Reviewer:** /improving-plans
**Date:** 2026-04-20

## Context verification (v2 claims)

Unlike v1, v2's code-path claims largely check out. Spot-checks:

| v2 claim | Verification |
|---|---|
| Chat inspector at `tools/agent-playground/src/lib/components/chat/chat-inspector.svelte` | Confirmed. Paired with `tools/agent-playground/src/lib/inspector-state.svelte.ts` (session-trigger logic). |
| `allowed-tools` in frontmatter | Confirmed schema at `skill-md-parser.ts:13` is `z.string().optional()` — comma-separated, **not an array** (tests at `local-adapter.test.ts:74` confirm shape "Read, Grep"). v2 should note this when discussing lint rules. |
| `add-skill.vercel.sh/audit` | Not verified as a supported API surface. No Anthropic-blessed docs; listed on the Vercel Labs CLI source. Treat as discovery channel, not security primitive. |
| Existing lint-warning event type | **Does not exist.** `skill-lint-warning` would be net-new in the data events schema at `packages/agent-sdk/src/messages.ts`. |
| Session-wide skill-load state | **Not maintained anywhere.** Tool calls live inside message parts; aggregation is the consumer's job. |
| Archive extraction cache | Confirmed at `load-skill-tool.ts:66-69` — `Map<"namespace/name/version", dir>`, cleaned up on session end. Lint cache should mirror shape. |

## Analysis of 5 new ideas

### 1. Eval gate for distilled system skills

- **Agree.** v2 requires the meta skill to self-lint but does not require its siblings to self-eval. That's hypocritical — eval-first is the meta skill's strongest rule.
- **Approach chosen for v3:** each `@atlas/creating-*` directory ships an `evals/` subdir with ≥3 cases (JSON per the agentskills spec format). New CI script `scripts/run-system-skill-evals.ts` baselines (no skill), runs with skill, fails on any regression.
- **Alternative considered:** manual eval in the distillation PR description. Rejected — not reproducible; degrades silently as prompts drift.
- **Alternative considered:** skip eval gate for v1, add later. Rejected — skills that ship without eval rarely get one retroactively; the bar should be set now while the set is small.

### 2. Context tab — session-wide skill-load aggregator

- **Agree — v2 says "latest assistant turn" which is too narrow.**
- **Approach chosen for v3:** `chat-context-state.svelte.ts` module derives `loadedSkills: {skillId, firstTurn, loadCount}[]` from the full message history. Updates on message append. Rendered in the Context tab with loading history.
- **Alternative considered:** per-turn display with a tab-switcher. Rejected — users care about the current state of context, not timeline per se.
- **Alternative considered:** server emits a `skill-loaded` data event consumed client-side. Feasible but duplicates state already in tool-call parts.

### 3. Lint `allowed-tools` against the tool registry

- **Agree.** Current schema allows `"allowed-tools": "nonExistentTool"` with no signal.
- **Approach chosen for v3:** linter splits the string on commas, trims, normalizes, and checks each entry against the `AtlasTools` registry. Unknown tool → warning (not error — handles forward-compat when new tools land). Also emit warning when the list is empty string (likely a mistake).
- **Alternative considered:** migrate schema to `z.array(z.string())`. Rejected — breaking change to published skills; string form is the agentskills.io spec.
- **Alternative considered:** strict error on unknown tools. Rejected — a skill imported from upstream might reference tools we don't support yet; too rigid.

### 4. Local audit heuristics beside the Vercel audit

- **Agree strongly.** Treating `add-skill.vercel.sh/audit` as the primary trust signal is a supply-chain risk.
- **Approach chosen for v3:** `localAudit(skill: Skill)` in `packages/skills/src/local-audit.ts`. Regex pass over SKILL.md + references + scripts for a small, curated risk list. Findings classified as `critical` (block install) vs `warn` (surface in preview).
- **Detection list (v1 rules):**
  - Prompt-injection preambles: `/ignore\s+(previous|above|prior|all)\s+(instructions|prompts)/i`, `/you are now/i`, `/new instructions/i`.
  - Env-var exfiltration: `/\$(OPENAI|ANTHROPIC|GOOGLE|GROQ|CORTEX)_API_KEY/`, `/ATLAS_[A-Z_]*_SECRET/`.
  - Privilege escalation: `\bsudo\b` outside fenced example blocks.
  - Network egress from scripts: `/curl\s+https?:/`, `/wget\s+https?:/` (curl to localhost is OK).
  - Path traversal: `/\.\.\/\.\.\//`, `/\/etc\/(passwd|shadow)/`.
- **Alternative considered:** use Vercel audit only. Rejected — external dependency; could silently stop working.
- **Alternative considered:** sandbox the skill and watch syscalls. Rejected — skills don't execute as code; they're prompts. Sandbox would miss prompt-injection entirely.

### 5. LRU cache for load-time lint

- **Agree.** Without it, every `load_skill` re-parses. Cheap to add.
- **Approach chosen for v3:** `Map<"skillId:version", LintResult>` inside `load-skill-tool.ts`, with bounded size (default 100 entries, LRU eviction). Invalidated by `setDisabled`, `publish`, and file-PUT via a shared invalidation helper.
- **Alternative considered:** no cache; rely on "it's fast enough". Rejected — fast pass still parses frontmatter YAML; over 20 skills × 10 turns this adds up.
- **Alternative considered:** cache in `SkillStorage` itself (deeper layer). Rejected — mixes concerns; lint is a display-layer concern.

## Overlap with prior art

- v1 review (`reviews/2026-04-20-skills-scoping-and-inspector-v1-review-report.md`) covered: trust tiers, distillation pathway, content-hash reconciliation, fork endpoint, load-time lint events. None of v2's new ideas duplicate that set.
- `docs/plans/2026-01-12-user-skills.md` — earlier skills stack doc. Eval-gate idea (#1) indirectly echoes the "draft-then-promote" pattern from that plan; v3 extends it with machine-verifiable evals rather than human-only review.

## Unresolved questions carried to v3

- **Eval framework for distilled skills.** There's no skill-eval harness today. Bootstrap script (`scripts/run-system-skill-evals.ts`) is new infrastructure. Keep v1 rules minimal: pass/fail on a small rubric, no fancy grading.
- **`allowed-tools` canonical form.** If we add lint warnings for this field, do we also canonicalize ("Read,Grep" vs "Read, Grep")? Proposal: no canonicalization — only validate; authoring tools can normalize if they choose.
- **Audit rule maintenance.** Who keeps the regex list current? Living document; revisit quarterly. Needs a `docs/security/skill-audit-rules.md` page once implemented.
- **Context-tab aggregation horizon.** Full message history or just current session? Current session is cheaper and matches user expectation. Carry forward.
- **Cache warmup on boot.** Should `ensureSystemSkills` pre-lint the bundled skills so they never trip the load-time cache miss? Probably yes for the 5 `@atlas/*` skills.

## Phase impact

v3 inserts two new small items and refines two existing phases. Total phases stay at 8 (0 + 7 functional). Specifically:

- Phase 4 (skill linter) gains the `allowed-tools` rule, `localAudit`, and the LRU cache.
- Phase 3 (Context tab) gains the session-wide skill-load aggregator.
- Phase 6 (system skills bootstrap) gains an eval gate (requires new CI harness).

No fundamental reshuffle — this is refinement, not architecture change.

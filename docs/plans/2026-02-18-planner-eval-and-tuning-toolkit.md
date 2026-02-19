# Planner Eval & Agent Tuning Toolkit

Shipped on `eval-planner` branch, 2026-02-19.

The workspace planner (`generatePlan()`) over-decomposed tasks into too many
agents — splitting same-service operations and injecting standalone summarizer
agents. This work added an eval suite to measure the problem, a CLI and
methodology for iterating on prompts, and the prompt fix itself. Eval results
went from 3/12 to 12/12.

## What Changed

### Planner Eval (`tools/evals/agents/planner/planner.eval.ts`)

Six cases x 2 modes (task/workspace) = 12 registrations testing agent-splitting
quality. Each case calls `generatePlan(intent, { mode })` and scores on:

- **agent-count** (0/1): agent count within expected range
- **no-duplicate-needs** (0/1): no two agents share identical `needs` arrays

Collapse cases (same service = 1 agent): Linear issue creation, Slack
search-and-post, calendar read-and-create. Split cases (different services = 2-3
agents): research-then-email, Linear-to-Notion, GitHub-to-Slack. Split cases
accept 2-3 agents — an optional summarizer between different services is
tolerable.

No daemon required. `fetchLinkSummary()` gracefully degrades to "no integrations
connected" when the daemon isn't running.

### Eval CLI Additions (`tools/evals/`)

- **`--tag <name>`** on `evals run` — tags all results in a run for later
  retrieval
- **`evals compare --before <tag|runId> --after <tag|runId>`** — structured A/B
  comparison showing improved/regressed/unchanged cases with full result payloads
- **`--verbose`** flag on compare adds score reasons and prompt snapshot diffs
- When multiple results share a tag (spot-check + full run), compare uses the
  latest runId per evalName — spot-checks are naturally superseded

### Tuning Skill (`.claude/skills/tuning-agents/`)

Agent-optimized reference card for the diagnose-change-run-decide loop. Includes
CLI reference, decision rules (if/then, not prose), anti-patterns, prompt
engineering principles (hard-won from the planner tuning session), and the
experiment log format spec.

### Experiment Log (`docs/experiments/workspace-planner.md`)

Markdown file persisting hypotheses, results, decisions, and learnings across
sessions. Current State section is the warm-start block for new sessions.
Learnings section captures agent-specific insights with generalizable principles.
Template lives at `.claude/skills/tuning-agents/references/experiment-log-template.md`.

### Planner Prompt Fix (`packages/workspace-builder/planner/plan.ts`)

Rewrote the agent-splitting rules in `SYSTEM_PROMPT_BASE`:

- Replaced "split by integration point and capability boundary" with "split by
  external service boundary — one agent per service"
- Added concrete same-service collapse examples (Calendar read+create, Slack
  search+post, Linear multi-op)
- Added explicit anti-summarizer directive
- Updated `formatUserMessage` suffix to align with the new framing
- Updated planning guidelines section to reinforce one-agent-per-service

## Key Decisions

**Eval runs without a daemon.** `generatePlan` calls `fetchLinkSummary()`
internally, which gracefully degrades when the daemon is down. The planner still
produces agents with correct `needs` — it just won't know which services are
connected. No stubbing needed.

**Split cases accept 2-3 agents.** An optional summarizer between different
services (e.g., research -> summarizer -> email) is tolerable. The hard failure
is same-service over-splitting, not cross-service summarizer injection.

**Compare works on full EvalResult objects.** Includes full `metadata.result`
from both runs in every entry — agents pick out what matters. No domain-specific
extraction logic to maintain.

**Prompt snapshots stored per eval result.** Each result captures the system
prompt that produced it in `metadata.promptSnapshot`. Survives across sessions —
the snapshot is stored with the result, not reconstructed from git.

**Concrete examples beat abstract rules in prompts.** The original prompt's
"each distinct capability" list was treated as an exhaustive hard constraint.
The fix uses concrete Good/Bad examples that the model pattern-matches against.

## Out of Scope

- Parallel experiment execution (agent teams running multiple prompt variants) —
  v2 when the sequential loop is proven
- Auto-generated experiment logs from tag metadata
- Needs accuracy scoring (validating each agent's `needs` against expected
  groups) — add when wrong-needs-assignment becomes a failure mode
- LLM judge scoring for ambiguous cases
- Cases with 3+ services to test fan-out patterns

## Test Coverage

- `tools/evals/lib/compare.test.ts` — `compareRuns()` with mock EvalResult
  pairs: improved, regressed, unchanged, new, removed cases. Compact and verbose
  output shapes. Latest-runId deduplication within tags.
- `tools/evals/lib/output.test.ts` — `readOutputDir` with tag filter
- `tools/evals/lib/run-eval.test.ts` — tag threading through to EvalResult
- `packages/workspace-builder/planner/plan.test.ts` — existing unit tests (4
  cases, all passing post-prompt-change)

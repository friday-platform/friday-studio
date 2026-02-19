---
name: tuning-agents
description: Structured methodology for iterating on agent prompts using the eval framework. Provides the diagnose-change-run-decide loop, CLI reference, decision rules, and experiment log format. Load when tuning agent behavior via eval results, when starting or continuing an agent tuning session, when asked to improve eval scores or fix agent failures, or when writing experiment logs.
---

# Tuning Agents

Structured loop: diagnose failure -> form hypothesis -> change one variable ->
run evals -> decide (keep/revert/iterate). Stop after 3 rounds without
improvement.

## CLI Reference

```bash
# Tagged full run
deno task evals run --tag <name>

# Spot-check specific cases before full run (do this first)
deno task evals run --tag <name> -F <case-substring>

# Compare two runs (tag or runId)
deno task evals compare --before <tag|runId> --after <tag|runId>

# Compare with score reasons and prompt diff
deno task evals compare --before <tag> --after <tag> --verbose

# Full trace for a single eval case
deno task evals inspect -e <evalName>

# Current failure summary
deno task evals report --failures
```

`evals compare` is the primary tool for iterative tuning — compare any two
tagged runs to see what improved, regressed, or stayed the same.

## Decision Rules

| Condition | Action |
|-----------|--------|
| All improved, none regressed | Keep change. Update experiment log. New tag becomes reference point. |
| Mixed (some improved, some regressed) | Change is directionally right but too aggressive. Analyze regressed cases. Add nuance, don't revert. |
| No improvement or all regressed | Revert. Try different approach. |
| 3 iterations without improvement | **Stop and escalate to user.** Likely stuck on prompt-level limitation or wrong eval expectations. |
| Helping category A but hurting category B | **Stop and escalate.** Prompt can't satisfy both constraints. Eval expectations or agent architecture needs to change. |

## Prompt Engineering Principles

Hard-won from tuning sessions. Apply these when diagnosing failures and forming
hypotheses.

**Enumerated lists are hard rules.** Models treat listed categories as
exhaustive constraints. If your prompt says "split by: A, B, C" the model will
always split on A, B, and C — even when context makes one irrelevant. Use
concrete examples instead of abstract category lists.

**Concrete examples beat abstract rules.** "ONE Calendar agent that reads events
AND creates meetings" is more reliable than "combine agents when they use the
same service." The model pattern-matches against examples more reliably than it
reasons about principles.

**Positive framing beats negative framing.** "Use ONE agent when operations
target the same service" works better than "Don't split agents that use the same
API." Both are weaker than examples showing the desired behavior.

**Check all prompt surfaces.** System prompt, user message template, tool
descriptions, planning guidelines — conflicting signals across surfaces create
unpredictable behavior. A rule in the system prompt gets undermined by a
contradicting instruction in the user message suffix. Aligned signals compound.

**Prompt snapshot scope is limited.** `metadata.promptSnapshot` captures
`getSystemPrompt()` and `formatUserMessage()` only — not capabilities sections,
integrations XML, or date injection. `evals compare --verbose` prompt diffs
won't show changes outside those two functions. When tuning touches non-prompt
inputs (capabilities descriptions, tool schemas), capture those in eval metadata
manually so diffs remain useful.

**"Combine only when" rules are too narrow.** Listing specific conditions for
combining ("only when operations are similar") gives the model an excuse to split
whenever it can argue dissimilarity. Frame the default as combining, with
exceptions for splitting.

## Anti-Patterns

- Don't change multiple variables at once -- can't attribute results
- Don't skip spot-checking with `-F` before full runs -- wastes tokens
- Don't reuse tags across conceptually different experiments
- Don't ignore regressed cases in a mixed result -- understand why before proceeding
- Don't iterate past 3 rounds without improvement -- escalate
- Don't forget `--verbose` on compare when you need score reasons and prompt diffs

## Experiment Log

Write to `docs/experiments/{agent-name}.md`. See
`.claude/skills/tuning-agents/references/experiment-log-template.md` for the
full template.

Key sections and why they matter:

- **Current State** — warm-start block. New sessions read this first to know
  what's passing, what's failing, and which tag to compare against.
- **Learnings** — insight/principle pairs from previous rounds. Read these
  before forming hypotheses — they encode why previous changes worked or failed.
- **Iteration Log** — what was tried, what happened, and whether the change was
  kept. Prevents repeating failed approaches across sessions.

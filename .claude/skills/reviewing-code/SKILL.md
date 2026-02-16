---
name: reviewing-code
description: Performs high-altitude code review focused on architecture, correctness, and test quality. Spawns 2 parallel agents — assumes low-level polish has already been handled. Triggers on "review this PR", "code review", "review branch".
argument-hint: "[branch or PR]"
---

# Code Review

You are an orchestrator running a focused code review. Two agents review in
parallel with distinct lenses, then you synthesize their findings into a review
document. No fixes — report only.

## Pre-fetched Context

Commit log:

!`git log main..HEAD --oneline 2>/dev/null || echo "No commits found"`

Changed files:

!`git diff --name-only main...HEAD 2>/dev/null || echo "No diff found"`

## Input

$ARGUMENTS

Parse for:
- **PR link** (GitHub URL like `https://github.com/org/repo/pull/123`) — use
  `gh pr view` and `gh pr diff`
- **Branch name** — compare to main
- If empty, compare current HEAD to main

## Phase 1: Gather Context

1. **Get the full diff** (pre-fetched file list above shows scope):
   ```bash
   git diff main...HEAD
   ```
   Or if PR link:
   ```bash
   gh pr diff <url>
   ```

   **Note:** `git diff HEAD~1` includes uncommitted working tree changes — use
   `git show <hash>` or `git diff HEAD~1 HEAD` for clean single-commit review.

2. **Get PR description** (if PR link):
   ```bash
   gh pr view <url>
   ```

3. **Find the plan:**
   - Check if any `docs/plans/*.md` appears in changed files
   - If found, read it — that's the plan for this work
   - If not, proceed without plan context

4. **Identify test files** in the diff (`*.test.ts`, `*.test.tsx`, `*.spec.ts`)

Store all context — you'll pass relevant slices to each agent.

## Phase 2: Spawn Review Agents

Spawn agents in parallel using the Task tool. Read
[agent-prompts.md](references/agent-prompts.md) for the full prompts to pass to
each agent.

### Agent 1: Architecture & Correctness

Loads karpathy-guidelines. Reviews plan adherence, correctness, security,
assumptions, complexity.

### Agent 2: Test & Integration

Loads testing skill. Reviews test quality, mock ratios, Vitest gotchas, coverage.

Skip Agent 2 if no test files in the diff. If no tests and the change is
non-trivial, note the absence in your synthesis.

**IMPORTANT:** Spawn both agents in the SAME message (parallel tool calls).

## Phase 3: Synthesize

When agents return:

### 3a: Collect

Store each agent's findings. If an agent fails or returns garbage, note it and
continue with the other.

### 3b: Determine Verdict

- **Clean** — Architecture is sound, no critical findings, tests are solid
- **Needs Work** — Substantive issues to address before merge
- **Rethink** — Fundamental design problems, needs discussion before proceeding

### 3c: Organize by Severity

Merge findings from both agents into a single list organized by severity, not by
agent. Deduplicate any overlap.

## Phase 4: Write Output

### Review Document

**Path:** `docs/reviews/YYYY-MM-DD-<name>.md`

Use the plan filename if a plan was found (e.g., `docs/plans/user-auth.md` →
`docs/reviews/YYYY-MM-DD-user-auth.md`). Otherwise use the branch name.

Create `docs/reviews/` if it doesn't exist.

```markdown
# Review: {branch-name}

**Date:** {YYYY-MM-DD}
**Branch:** {branch}
**Verdict:** {Clean | Needs Work | Rethink}

## Summary

{2-3 sentences — what the change does and the review's take}

## Critical

{Critical findings — bugs, security, correctness. Each with location, problem,
recommendation. Or "None."}

## Important

{Important findings — architecture, design, assumptions. Or "None."}

## Tests

{Test findings, coverage gaps. Or "No test files in diff." Or "Tests look
solid."}

## Needs Decision

{Numbered list of items requiring author judgment, with enough context to
decide. Or omit section if nothing needs a decision.}
```

### Terminal Summary

```
Review complete.
  Verdict: {verdict}
  Critical: {n} | Important: {n} | Tests: {n}
  Written to: docs/reviews/YYYY-MM-DD-{name}.md
```

If verdict is **Rethink**:
> "Fundamental design issues found. Read the review before proceeding."

If there are critical findings:
> "Most important: {top finding summarized in one line}."

## Error Handling

- **Git diff fails** — tell user and abort
- **PR link invalid** — tell user and abort
- **Agent returns garbage** — continue with the other, note in summary
- **No test files in diff** — skip Agent 2, note absence if change is
  non-trivial

---
name: polishing
description: Runs a self-review and polish pass before opening a PR. Spawns a team of fix-oriented agents (lint/types, slop/comments, test quality, design/correctness) that clean up the branch and only escalate critical issues. Triggers on "polish", "self-review", "clean up before PR".
argument-hint: "[branch]"
---

# Polish — Self-Review Team

You are the team lead for a polish pass. Your job is coordination, triage, and
quality enforcement. You do NOT write code — you delegate everything.

## Input

$ARGUMENTS

Parse for:
- **Branch name** — compare to main
- If empty, compare current HEAD to main

## Phase 1: Gather Context

1. Get the diff: `git diff main...HEAD`
2. Get changed files: `git diff --name-only main...HEAD`
3. Find plan docs: check if any `docs/plans/*.md` appears in changed files — if
   found, read it
4. Identify test files in the diff (filter for `*.test.ts`, `*.test.tsx`,
   `*.spec.ts`)

Store all context — you'll pass relevant slices to each reviewer.

## Phase 2: Spawn Review Agents

Create a team and spawn **four agents in parallel**. Read
[agent-prompts.md](references/agent-prompts.md) for the full prompts to pass to
each agent.

**IMPORTANT:** Spawn all four agents in the SAME message (parallel tool calls).

| Agent | Lens | Can fix? |
|---|---|---|
| Lint & Types | Mechanical lint/type fixes | Yes |
| Slop & Comments | AI slop, comment noise | Yes |
| Test Quality | Test anti-patterns, Vitest gotchas | Yes |
| Design & Correctness | Architecture, correctness | Report only |

- **Agents 1-3** fix directly and commit their changes.
- **Agent 4** produces findings only — no code changes.
- If no test files in the diff, skip Test Quality.

## Phase 3: Triage

When all agents return:

### 3a: Collect Results

- Agents 1-3: their commits are already landed. Collect their summaries.
- Agent 4: design findings to triage.
- Any "needs-decision" items from agents 1-3 (things they couldn't fix).

### 3b: Triage into Buckets

For every finding from agent 4 + unfixed items from agents 1-3:

**Ask: "Does this require human judgment?"**

- **No** → Spawn a fixer teammate with a specific, scoped instruction. The
  fixer commits and reports back. See the fixer template in
  [agent-prompts.md](references/agent-prompts.md).
- **Yes** → Goes in the escalation doc. Reserve this for:
  - P1 bugs (security, data loss, crash paths)
  - Architectural concerns that change the approach
  - Design decisions with genuine tradeoffs
  - Anything where "just fix it" could make things worse

Err on the side of fixing. If you can write a clear, unambiguous fix
instruction, it doesn't need a human.

### 3c: Final Gate

After all fixers complete:

1. Run `deno task lint` — must pass
2. Run `deno check` — must pass
3. If either fails, spawn one more fixer to clean up

## Phase 4: Output

### Terminal Summary

Always print. Terse.

```
Polish complete.
  Fixed: N items (X comments, Y lint, Z slop, W tests)
  Commits: N
  Escalated: N items → docs/reviews/YYYY-MM-DD-<branch>.md
```

If nothing escalated:

```
Polish complete.
  Fixed: N items (X comments, Y lint, Z slop, W tests)
  Commits: N
  Clean — nothing to escalate.
```

### Escalation Doc

**Only created if there are escalated items.**

**Path:** `docs/reviews/YYYY-MM-DD-<branch-name>.md`

Create the `docs/reviews/` directory if it doesn't exist.

```markdown
# Polish: {branch-name}

**Date:** {YYYY-MM-DD}
**Branch:** {branch}

## Needs Decision

### 1. {Issue Title}

**Severity:** Critical / Important
**Location:** `file:line`
**Problem:** {1-2 sentences}
**Recommendation:** {what to do}

### 2. ...
```

No per-agent sections. No narrative. Just the items that need eyeballs.

### Report to User

After printing the summary:

- If there are escalated items: "I've flagged {N} items that need your input.
  Most important: {top item summarized in one line}."
- If clean: done. No extra commentary.

## Teammate Names

Use the seed roster from the `implement-team` skill. Shuffle into random order
before spawning.

## Teammate Rotation

Reviewers are one-shot — they do their review pass and shut down. Fixers are
also one-shot — one fix, one commit, done.

## Error Handling

- **Git diff fails** → tell user and abort
- **`deno task lint` or `deno check` not available** → skip that agent, note in
  summary
- **Agent returns garbage** → skip it, continue with others, note in summary
- **<2 agents return usable results** → warn user but proceed
- **No test files in diff** → skip Test Quality agent
- **Final gate fails after fixer attempt** → report remaining errors in
  escalation doc

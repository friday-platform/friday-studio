---
name: qa
description: >
  QA testing for Friday. Plan test cases interactively for inflight features,
  run smoke tests against the live product, or autonomously QA+fix with
  escalation. Triggers on: "qa this feature", "smoke test", "verify this works",
  "test the release", "qa and fix", "run my test plan", "run QA".
argument-hint: "<feature-or-plan-doc> | run <plan-doc|smoke> | fix <plan-doc>"
---

# QA

Three modes: **plan** test cases, **run** them, or **run + fix** autonomously.

## First: Load Product Context

Read `docs/product-map.md` for ports, routes, API endpoints, CLI commands, and
auth details. This is the operational reference for interacting with Friday.

## Mode Detection

Parse the argument to determine mode:

- Starts with `run` → Run mode (`run smoke` or `run <path-to-plan>`)
- Starts with `fix` → Fix mode (`fix <path-to-plan>`)
- `smoke` alone → Run mode with smoke matrix
- Anything else → Plan mode (default)

## Environment Check

Before doing anything, verify the environment is ready. **Ask the user for help
if something is wrong — don't guess, don't skip, don't try to fix environment
issues yourself.**

1. Is the daemon running? (`deno task atlas daemon status`)
2. If UI cases are involved, is the web client running? (check `localhost:1420`)
3. Are required credentials/integrations configured for the feature under test?

If any check fails, stop and tell the user exactly what's needed:
- "The daemon isn't running. Start it with `deno task atlas daemon start --detached`"
- "This feature needs a Slack integration configured. Can you set that up in
  Settings?"
- "I need OAuth credentials for Google — can you walk me through the setup?"

Do not proceed with cases that depend on missing prerequisites.

## Mode: Plan

Interactive session to develop test cases for a feature. Mirrors the
brainstorming skill — one question at a time, validate incrementally.

### Process

1. **Gather context** — read the plan doc (if referenced), diff the branch
   against main, explore changed files, relevant routes/endpoints/agents. Use
   sub-agents for exploration. Check the `feature-flags` skill — if the feature
   is behind a flag, note the flag name and document how to enable it in
   prerequisites.
2. **Ask questions** to understand what matters. One at a time. Multiple choice
   when possible. Focus on: critical paths, known edge cases, what "working"
   looks like.
3. **Present cases** in sections for validation. Each case needs:
   - **Trigger** — the specific action to exercise the feature
   - **Expect** — what "good" looks like, described naturally
   - **If broken** — breadcrumbs for investigation (log commands, endpoints,
     files to check)
4. **Write the plan doc** to `docs/qa/plans/<feature>-cases.md`
5. **Suggest smoke candidates** — which cases are durable enough for the smoke
   matrix at `docs/qa/smoke-matrix.md`
6. **Update the product map** — if you discovered new routes, endpoints, or
   behaviors not in `docs/product-map.md`, add them. The map stays current
   through QA planning, not separate maintenance.

### Case Quality Bar

Could you paste this case cold into a chat and get useful QA out of it? If not,
add more context or a better trigger. Don't overspecify — the executing agent is
Opus and will figure out intermediate steps.

### Plan Doc Template

```markdown
# QA Plan: <Feature Name>

**Context**: <plan doc path or brief description>
**Branch**: <branch name>
**Date**: YYYY-MM-DD

## Prerequisites
- <what needs to be true before running (daemon, credentials, test data)>

## Cases

### 1. <Descriptive case name>
**Trigger**: <specific action — CLI command, URL to visit, prompt to send>
**Expect**: <natural language description of success>
**If broken**: <where to look — log commands, endpoints, relevant files>

## Smoke Candidates
- Case N (why it's durable enough for regression)
```

## Mode: Run

Execute test cases and produce a report. No fixing, no interruptions.

### Process

1. **Load cases** — read the plan doc or `docs/qa/smoke-matrix.md`
2. **Verify prerequisites** — run the environment check above
3. **Load tools** — load the playwriter skill for UI cases, use atlas CLI for
   daemon interaction, curl for API probing. If any cases involve flagged
   features, enable the flags per the `feature-flags` skill before testing.
4. **Execute cases** sequentially (cases may reference earlier results). For each
   case:
   - Execute the trigger
   - Evaluate the expected outcome
   - Capture diagnostic context (API responses, CLI output, screenshots)
   - Record pass/fail/skip
5. **Write report** to `docs/qa/reports/YYYY-MM-DD-<topic>.md` using the
   template in `references/report-template.md`
6. **Print terminal summary** — pass/fail/skip counts, list of failures

## Mode: Fix

Run + autonomous fix loop. Execute cases, and when something fails, spawn a
fixer teammate to investigate and fix before moving on.

**You are the team lead.** You coordinate, review diffs, and triage — same role
as in the `implementing-tasks` skill. You do NOT write code.

**Preflight**:

1. Verify agent teams are available (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`). If
   not available, fall back to sub-agents via the Task tool.
2. Create a team via `TeamCreate`
3. Shuffle the teammate name roster from `implementing-tasks`

Load `references/fix-loop-protocol.md` for the full protocol. The short version:

1. Run the case
2. On failure → spawn a one-shot fixer teammate (fresh context per attempt)
3. Review their diff — same quality gates as `implementing-tasks` (types, hard
   rules, surgical changes)
4. Retest after fix
5. Shut down the fixer, repeat until pass or escalation
6. Escalate to the human when:
   - It's a design decision, not a bug
   - Retried 3 times and still failing
   - Needs credentials or environment context
   - Something works but looks wrong (UX, visual)
7. Write report with additional "Changes Made" and "Escalations" sections

## When to Ask the Human

Throughout all modes, ask for user intervention when:

- **Environment isn't right** — missing services, expired credentials, port
  conflicts
- **Ambiguous result** — the case didn't clearly pass or fail
- **Credential/auth needed** — OAuth flow, API keys, service configuration
- **Design question** — "should this show a modal or redirect?" is not your call
- **External dependency** — third-party service is down, rate limited, etc.

Don't burn cycles guessing. Ask early, ask clearly, include what you've already
tried.

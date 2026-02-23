# Fix Loop Protocol

When `/qa fix` encounters a failing case, follow this loop.

## Team Setup

Fix mode uses agent teams following the same patterns as `implementing-tasks`.
You are the team lead — you coordinate, review, and triage. You do NOT write
code.

1. **Create a team** via `TeamCreate`
2. **Use the teammate name roster** from `implementing-tasks` — shuffle into
   random order before spawning. Each fixer gets a fresh name.
3. **Spawn fixers one at a time** per failure (not in parallel — fixes are
   sequential since later cases may depend on earlier fixes)

If agent teams are unavailable (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` not set),
fall back to sub-agents via the Task tool. Same prompt, same review process.

## Per-Failure Loop

1. **Capture the failure** — what happened, error messages, API responses,
   screenshots, relevant log output
2. **Spawn a fixer teammate** using the prompt template below. Each fixer is
   one-shot — one fix, one commit, done. Fresh context per attempt (no
   accumulated pollution from previous failures).
3. **Review the fix** — when the teammate returns, review their diff:
   ```bash
   git log -1 --stat
   git diff HEAD~1 HEAD
   ```
   Check:
   - Does the fix address the root cause or just the symptom?
   - If the bug was in testable code, did they add a regression test?
   - No `as` assertions, no `any`, no `console.*`, `withUserContext()` for
     user-scoped queries
   - Is this the smallest change that fixes the issue? (karpathy: surgical)
   - Type check the changed files: `git diff HEAD~1 --name-only | xargs deno check`
4. **If review fails** — message the teammate with specific feedback. They fix
   and resubmit. Then shut them down (one fix per teammate).
5. **Retest** — run the same case again
6. **If still failing** — shut down the current fixer, spawn a fresh one with
   breadcrumbs from the previous attempt (what was tried, what the result was).
7. **Max 3 retries per case** — after 3 failed fix attempts, escalate.

## Escalation Rules

Escalate to the human (don't keep looping) when:

- **Ambiguous** — the failure looks like a design decision, not a bug. "Should
  this show a modal or inline?" is not something to guess at.
- **Stuck** — 3 fix attempts haven't resolved it. Include all diagnostic context
  from each attempt.
- **Environment** — needs credentials, config, or external service access that
  the agent can't resolve.
- **Looks wrong** — the feature works but the result seems off. UX nits, visual
  issues, copy that doesn't read right. Flag it, don't "fix" it.

## Fixer Teammate Prompt

Spawn fixers using the Task tool with `team_name` set to the QA team. Use
`subagent_type: "general-purpose"` so they have full edit/write/bash access.

```
You are {name}, a QA fixer on the Friday team.

## Skills to Load

Load these before doing anything:
- debugging (investigation methodology — four phases, no fixes without root cause)
- debugging-friday (log access for Friday-specific debugging)
- testing (test methodology, Vitest patterns)
- karpathy-guidelines (surgical changes, simplicity)
- committing (commit format with Key Learnings)

## Your Assignment

Failing QA case:
- Trigger: <what was done>
- Expected: <what should have happened>
- Actual: <what happened instead>
- Breadcrumbs: <the "if broken" hints from the case>

<Previous attempt context if retry — what was tried, what the result was>

## Workflow

1. Load the skills above
2. Investigate: follow the debugging skill's four-phase framework. No fixes
   without root cause understanding. Use debugging-friday for log access.
3. Red/green: if the bug is in testable code (logic, parsing, state transitions,
   API handlers), write a failing test first, then make it green. Skip for pure
   UI issues, config problems, or wiring bugs where a test would just restate
   the integration.
4. Fix: implement the smallest change that addresses the root cause
5. Verify:
   - `deno check <your-changed-files>` — type errors are a hard stop
   - `deno task test <file>` — tests must pass
6. Commit using the committing skill format. Include Key Learnings if you
   discovered something non-obvious.
7. Message the lead: "Fixed: <1-line summary of root cause and fix>"

## Rules

- One fix only — do exactly what's needed, nothing more
- No `as` type assertions — use Zod schemas for parsing
- No `any` types — use `unknown` or proper types
- No `console.*` — use `@atlas/logger`
- Static imports only at top of file
- All user-scoped database queries MUST use `withUserContext()`
- The daemon live reloads on code changes — no restart needed
- This codebase will outlive you. Fight entropy.

## If Blocked

Don't force it. Stop before making things worse.
1. Commit partial work if any, noting it's incomplete
2. Message the lead: "Blocked: <specific reason>"
```

## Teammate Lifecycle

Fixers follow the same rotation philosophy as `implementing-tasks`:

- **One-shot** — each fixer handles one fix attempt, then gets shut down
- **Fresh context** — a retry spawns a brand new teammate with clean context,
  plus breadcrumbs from the previous attempt
- **Why**: context accumulation from failed attempts degrades the next attempt.
  A fresh teammate with a summary of "what was tried and failed" produces
  better work than one carrying the full weight of previous failures.

## Report Additions

In fix mode, the report includes two extra sections:

**Changes Made** — for each fix applied:
- Which case it fixed
- What the root cause was
- What files were changed
- Brief description of the fix

**Escalations** — for each issue escalated to the human:
- Which case
- What was tried (all attempts)
- Why it's being escalated
- Diagnostic context for the human to pick up from

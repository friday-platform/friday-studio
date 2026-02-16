---
name: implementing-tasks
description: Orchestrates parallel task implementation using agent teams — spawns implementing teammates with quality review gates. Activates when given 4+ independent tasks, or on "implement these tasks", "parallelize this work", "run a team on these".
---

# Team Lead - Parallel Task Implementation

You are the team lead. Your job is coordination and quality enforcement. You do
NOT write code.

## Preflight

Before doing anything else, check that agent teams are enabled:

```bash
echo $CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
```

If the value is empty or unset, **stop** and tell the user:

> Agent teams require `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` to be enabled.
> Add it to your Claude Code settings (`~/.claude/settings.json`):
>
> ```json
> {
>   "env": {
>     "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
>   }
> }
> ```
>
> Then restart this session.

Do not proceed to Startup until this check passes.

## Startup

1. **Survey** - `TaskList` to see all tasks
2. **Assess** - Count pending tasks, check Starting Points for file overlap
3. **Plan waves** - Group tasks into waves by dependencies. Assign tasks per
   teammate based on weight (see Teammate Rotation). Context window degrades
   with accumulated context — keep teammates in the "smart window".
4. **Plan concurrency** - How many teammates can run in parallel without file
   conflicts? (max 5 concurrent)
5. **Spawn first wave** - Create team, spawn teammates for wave 1
6. **Enter delegate mode** - Shift+Tab to restrict yourself to coordination only

## Teammate Names

Shuffle the seed roster into a random order before spawning any teammates. Use
that shuffled order for the session. When a teammate is shut down and replaced,
the replacement gets the next unused name from the shuffled list.

**Seed roster**: Jinju, Almond, Leela, Po, Luka, Ferox, Ponderosa, Ellie, Storm,
Patina, Jerry the Squirrel

If you burn through the seed roster, make up more pet names on the fly.

## Spawning Teammates

Spawn each teammate using the canonical prompt in
[`../ralph/references/teammate-prompt.md`](../ralph/references/teammate-prompt.md).
Replace `{name}` with the teammate's assigned name from the roster.

## Teammate Rotation

Teammates are disposable. Shut them down and spawn fresh replacements before
context accumulation degrades output quality. The task cap depends on task
weight:

| Task weight | Examples                                                                   | Max tasks per teammate |
| ----------- | -------------------------------------------------------------------------- | ---------------------- |
| **Heavy**   | Multi-file implementations, compiler logic, LLM integration, orchestration | **1**                  |
| **Medium**  | Single-module features, test suites, planner phases                        | **2**                  |
| **Light**   | Fixtures, utility functions, single-function implementations               | **3**                  |

**How to gauge weight**: Check the task's Starting Points and Acceptance
Criteria. Many files to explore + complex logic = heavy. Single file + focused
scope = light.

**Tracking**: Maintain a mental count of completed tasks per teammate. When a
teammate hits their cap:

1. Send shutdown request after approving their final task
2. Spawn a fresh replacement with the same prompt
3. The new teammate picks up from the task list naturally

**Why this matters**: Context accumulation degrades output quality. A teammate
on task #5 is working with all the context from tasks #1-#4 polluting its
window. Fresh teammates start clean, explore the codebase with fresh eyes, and
produce higher quality work.

## Task Assignment

Let teammates self-claim from the shared task list. Before they start, check for
file overlap:

- If two pending tasks share Starting Points files, assign them sequentially
  (second task only after first completes)
- If tasks are in different modules/directories, they can run in parallel

## Quality Gates

### Gate 1: Plan Approval (selective)

Only require plan approval for tasks with these prefixes in the subject:

- **"Tracer Bullet:"** - Sets patterns others will follow. Review the approach.
- **"High Risk:"** - Could break things. Review before implementing.

When reviewing a plan:

- Does it use Zod parsing instead of type assertions?
- Is it the simplest approach that satisfies the AC? (YAGNI)
- Does the test strategy test behavior, not implementation details?
- Does it follow existing patterns from recent commits?

Approve or reject with specific, actionable feedback.

All other tasks skip plan approval - teammates implement directly.

### Gate 2: Diff Review (every task)

When a teammate messages "Task X complete":

1. Load these skills for review context:
   - `karpathy-guidelines`
   - `testing`
   - `reviewing-comments`
2. **Type check the changed files** before reading the diff:
   ```bash
   git diff HEAD~1 --name-only | xargs deno check
   ```
   If type errors exist, **reject immediately** — don't waste time on visual
   review until types are clean. Send the error output to the teammate.
3. Review the changes:
   ```bash
   git log -1 --stat
   git diff HEAD~1
   ```
4. Check against quality standards:
   - **karpathy**: Is this the smallest change? Any speculative code? Any
     unnecessary abstractions?
   - **testing**: Do tests verify behavior or mock internals? Any
     test-only methods added to production code?
   - **CLAUDE.md hard rules**: No `as`, no `any`, no `console.*`, static
     imports, Zod at boundaries, `withUserContext()` for all user-scoped
     database queries
   - **Database isolation** (if diff touches SQL, adapters, or repositories):
     load `database-rls` skill and verify compliance
   - **Patterns**: Does it match the style of recent commits?
5. **Approve** → Confirm to teammate. Check their task count against their
   weight cap (see Teammate Rotation):
   - Under cap → they claim next task
   - At cap → shutdown this teammate, spawn fresh replacement
6. **Reject** → Send specific feedback: what's wrong, what to do instead.
   Teammate fixes and resubmits. (Rejections don't count toward the cap.)

### Gate 3: Full Type Check (after each wave)

After approving all tasks in a wave, before spawning the next wave:

```bash
deno check
```

If errors exist, create fix tasks and resolve them before starting the next wave.
Type debt compounds across waves — a broken type in wave 1 cascades into every
wave that follows. Catch it early.

### Escalation

If a teammate is rejected twice on the same issue, escalate to the user. Don't
let the feedback loop spin.

## Handling Blockers

When a teammate reports blocked:

- **Codebase question** → Investigate yourself or spawn an explore subagent
- **Prerequisite work** → Check if another teammate's in-progress task resolves
  it. If so, tell the blocked teammate to wait. If not, create a new task.
- **Needs human input** → Ask the user
- **Unclear** → Read the teammate's commits to understand what happened

## Learnings Capture

Throughout the session, maintain a learnings file at
`docs/learnings/YYYY-MM-DD-<branch>.md`. Append notes whenever you observe
something worth remembering:

- A mistake two teammates made independently (suggests a CLAUDE.md gap)
- A codebase quirk that confused a teammate during exploration
- A pattern you noticed during diff review that isn't documented
- A rejection reason that keeps recurring

Keep it free-form. One line per observation is fine. This file gets consumed by
the `remembering-learnings` skill and curated into CLAUDE.md.

Create the `docs/learnings/` directory if it doesn't exist. Commit the file at
session end with: `chore(meta): capture team lead learnings`

## Completion

When all tasks are complete:

1. Run a final verification:
   ```bash
   deno check         # Type check — must be clean
   deno task lint     # Lint — must pass
   deno task fmt      # Format — commit if changes
   ```
2. If any errors, create fix tasks and resolve before finishing
3. Run `git log` to see all commits from this session
4. Commit the learnings file if it has content
5. Summarize to the user: what was done, any decisions made, any concerns
6. Clean up the team

## Rules

- **Never write code yourself** - delegate everything
- **Review every completed task** - no exceptions
- **Be specific in feedback** - "don't use `as`" not "improve type safety"
- **Trust teammates on first attempt** - only intervene after they submit
- **Escalate early** - 2 rejections = ask the user
- **Monitor file conflicts** - if two teammates are in the same directory, pause
  one

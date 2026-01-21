---
name: ralph-prd
description: >
  Transform design documents into structured JSON PRDs for autonomous Ralph loop execution.
  Use when: (1) A design doc exists from brainstorming and needs to become executable tasks,
  (2) User invokes /ralph-prd with a path to a design document,
  (3) User wants to set up autonomous agent execution via Claude Code CLI.
  This skill asks clarifying questions about verification and TDD applicability, then outputs
  PRD.json + progress.txt for Ralph loops.
---

# Ralph PRD Generator

Transform brainstorming output into structured PRDs for autonomous Ralph loop execution.

## Workflow

```
/brainstorm → design.md → /ralph-prd design.md → PRD.json + progress.txt → Ralph loop
```

## Invocation

```bash
/ralph-prd docs/plans/2026-01-21-feature-design.md
```

## Process

### 1. Read Design Document

Parse the design doc passed as argument. Extract:
- Goal and success criteria
- Discrete units of work
- Technical decisions already made
- Out-of-scope items

### 2. Generate Candidate Tasks

Break the design into feature-atomic tasks. Each task should be completable in one Ralph
iteration (one context window). If a task feels too large, split it.

Right-sized tasks:
- Add a Zod schema for X
- Implement route handler for Y
- Add rate limiting middleware
- Write integration test for Z

Too large:
- Implement entire authentication system
- Build the frontend

### 3. Classify Each Task

Determine the verification tier for each task:

| Tier | Anchor Pattern | Default Verification |
|------|----------------|---------------------|
| backend | Pure logic, schemas, utilities | `deno check`, `deno lint`, `deno task test <file>` |
| api | `apps/atlasd/routes/`, endpoints | Above + `curl localhost:8080/<endpoint>` |
| frontend | `apps/web-client/` | Above + browser verification via agent-browser |

### 4. Ask Clarifying Questions

Ask ONE question at a time when:

**Tier unclear:**
> "This task touches [X]. Should I classify it as backend, api, or frontend?"

**TDD applicability unclear:**
> "This task involves [daemon lifecycle/config changes/etc]. TDD doesn't fit cleanly.
> Should I: (A) Include TDD phases anyway, (B) Skip TDD, use verification only, (C) Other?"

**Custom verification needed:**
> "The design mentions [specific validation]. What command verifies this works?"

### 5. Determine TDD Phases

Include `tdd` field for TDD-friendly tasks:
- Zod schemas and validation
- Pure functions and utilities
- FSM transitions and guards
- Domain logic isolated from I/O
- Error handling

Omit `tdd` field for:
- YAML/config changes
- CLI output formatting
- Daemon lifecycle management
- Svelte components (no test infra)
- Tasks marked exploratory in design

When uncertain, ask.

### 6. Generate Output

Write to `scripts/ralph/`:
- `PRD.json` - Structured task list
- `progress.txt` - Empty, ready for iteration logs

## Output Schema

See [references/schema.md](references/schema.md) for complete PRD.json schema.

### PRD.json Structure

```json
{
  "meta": {
    "id": "prd-<date>-<slug>",
    "title": "Human readable title",
    "designDoc": "path/to/design.md",
    "created": "ISO timestamp"
  },
  "scope": {
    "goal": "One sentence goal",
    "successCriteria": ["Criterion 1", "Criterion 2"],
    "outOfScope": ["Thing 1", "Thing 2"]
  },
  "tasks": [
    {
      "id": "task-1",
      "description": "Clear description of what to implement",
      "anchor": "path/to/starting/file.ts",
      "tier": "backend|api|frontend",
      "tdd": {
        "red": "Specific failing test to write",
        "green": "Minimal implementation to pass",
        "refactor": "Optional cleanup"
      },
      "verification": ["command 1", "command 2"],
      "acceptanceCriteria": ["Criterion 1", "Criterion 2"],
      "passes": false
    }
  ],
  "complete": false
}
```

### progress.txt Format

Each iteration appends:

```
## <timestamp> - <task-id>
Commit: <sha> (<conventional commit message>)

Decision: <noteworthy decision and reasoning>

Tuning: <observations for refining the loop>

---
```

## Ralph Loop Instructions

Include these instructions with the PRD (in prompt or separate file):

```
Read @scripts/ralph/PRD.json and @scripts/ralph/progress.txt

1. Find an incomplete task (passes: false)
2. If task has tdd field:
   - Write test from tdd.red
   - Run verification - confirm FAILS
   - Implement tdd.green
   - Run verification - confirm PASSES
   - Apply tdd.refactor if present
3. If no tdd field:
   - Implement the task
   - Run verification commands
4. Verify acceptanceCriteria met
5. Set passes: true in PRD.json
6. Commit with conventional commit message
7. Append to progress.txt: task ID, commit SHA, decisions/tuning notes
8. If all tasks pass AND scope.successCriteria verified:
   output <promise>COMPLETE</promise>

ONLY WORK ON ONE TASK PER ITERATION.
```

## Completion

After generating PRD, output:

```
PRD generated at scripts/ralph/PRD.json

To run HITL (single iteration, watch and learn):
  ./scripts/ralph/ralph-once.sh

To run AFK (N iterations):
  ./scripts/ralph/ralph.sh 20
```

## Learning Graduation

Tuning notes in progress.txt capture cross-task learnings. Post-sprint:
1. Human reviews tuning notes
2. Promotes useful patterns to CLAUDE.md
3. Discards one-off decisions

This keeps CLAUDE.md human-curated while surfacing agent discoveries.

## Key Principles

- **Agent chooses tasks** - PRD is a menu, not a sequence
- **JSON format** - Less likely to be rewritten mid-loop
- **TDD by default** - Where it fits, encode test-first in task structure
- **Tiered verification** - Backend/API/Frontend get appropriate checks
- **Explicit scope** - Prevents premature victory declarations
- **Ask when unclear** - Better to clarify than guess wrong

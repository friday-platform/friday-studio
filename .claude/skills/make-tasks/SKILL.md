---
name: make-tasks
description: Create outcome-focused tasks for agent execution from design docs or conversation context
disable-model-invocation: true
---

# Make Tasks

Create outcome-focused tasks for agent execution.

## Input

Either:

- A design doc path: `/make-tasks docs/plans/2026-01-21-foo-design.md`
- Current conversation context: `/make-tasks` (uses what we've been discussing)
- Specific work: `/make-tasks fix the auth race condition we identified`

## Process

1. **Understand the work** - If given a design doc, read it. If given context,
   synthesize from conversation. What needs to happen?

2. **For larger efforts, identify the tracer bullet** - "What's the thinnest
   slice that proves the approach?" Prefix with "Tracer Bullet:". Skip for
   single bug fixes.

Tracer bullets comes from the Pragmatic Programmer. When building systems, you
want to write code that gets you feedback as quickly as possible. Tracer bullets
are small slices of functionality that go through all layers of the system,
allowing you to test and validate your approach early. This helps in identifying
potential issues and ensures that the overall architecture is sound before
investing significant time in development.

TL;DR - build a tiny, end-to-end slice of the feature first, then expand it out.

3. **Break work into tasks** - Each task:

   - Outcome-focused (what's true when done)
   - Independently valuable where possible
   - Sized for a single focused session

Make each task the smallest possible unit of work. We don't want to outrun our
headlights. Aim for one small change per task.

4. **Explore to answer unresolved questions**: If you have questions, attempt to
   answer them using sub-agents to explore the codebase. If there are any that
   need human judgement, present them to the user. Adjust the tasks as needed.

5. **Review with user** - Present a summary of the tasks to the user, along with
   key decisions you made, q&a from 'unresolved questions'.

6. **Create tasks** - Use `TaskCreate` for each.

## Task Template

**Subject**: Imperative, outcome-focused. Prefix with "Tracer Bullet:" or "High
Risk:" when relevant.

**Description**:

```
## Context
[2-4 sentences: The problem being solved and high-level approach. This is the
"why does this project exist" briefing that lets someone start cold.]

## Outcome
[What's true when THIS task is done - user/product level]

## Why This Task
[How this fits into the larger effort. What came before that this builds on.
What this enables next. 1-2 sentences.]

## Acceptance Criteria
- [ ] [Binary verifiable - behavioral, specific]

## Interface Contracts
[For integration tasks: specific schemas, function signatures, or data
structures this task must produce or consume. Skip for purely additive tasks.
Inline the contracts - these are hard requirements, not suggestions.]

## Starting Points
- [Required. File paths, function names, relevant patterns to follow]

## Design Reference
[Link to design doc section if one exists: "docs/plans/foo.md § Section Name"]
```

## Guidelines

Make each task the smallest possible unit of work. We don't want to outrun our
headlights. Aim for one small change per task.

- **Context = cold start briefing** - Someone with zero context should
  understand the problem and approach in 30 seconds
- **Why This Task = sequence** - What came before, what this enables
- **Inline contracts, reference implementation** - Shapes and signatures yes,
  code examples no. Trust the agent to figure out the how.
- **Behavioral AC only** - "returns 201 with user object", not "tests pass"
- **AC implies verification** - Write AC so testing approach is obvious.
  "Returns `{ schema }` with rowCount" → unit testable. "Clicking Download
  triggers export" → browser verification.
- **Starting points are required** - File paths and function names, not vague
  hints
- **No implementation steps** - trust the agent
- **No dependencies** - flat queue, orchestrator sequences
- **Flag risk/tracer bullets in subject** - orchestrator uses these signals

## Examples

See [examples/sample-tasks.md](examples/sample-tasks.md) for well-formed tasks.

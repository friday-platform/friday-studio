---
name: summarizing-plan
description: >
  Consolidates completed planning documents into a concise source-of-record
  reference. Activates after a feature is implemented with plan docs to distill.
  Triggers on "close out the plan", "consolidate the plan docs",
  "create a source of record", "archive these design docs".
argument-hint: "[plan docs glob]"
---

# Summarize Plan

Distill planning artifacts into a single source-of-record document after
implementation is complete.

## When This Applies

- Feature is implemented and merged (or about to be)
- Multiple plan doc versions exist (`.v2.md`, `.v3.md`, review reports)
- Planning docs contain implementation noise that's no longer useful

## Process

1. Read all related plan docs (all versions, review reports)
2. Identify what was actually built vs. what was speculative
3. Write a single consolidated doc
4. Confirm output with the user

## Output Structure

Write to `docs/plans/YYYY-MM-DD-feature-name.md` (no version suffix — this is
the final record). Use the earliest date from the source docs or the current
date, whichever makes more sense contextually.

```markdown
# Feature Name

One-line: when it shipped, what branch.

One paragraph: what the feature does and why it exists. Enough context that
someone unfamiliar can orient themselves.

## What Changed

Per-module or per-area sections describing what was built. Focus on _what_ and
_where_, not step-by-step implementation instructions. Include enough detail
that someone modifying this code later knows the shape of the system.

## Key Decisions

Architectural choices with rationale. These are the "why" decisions that aren't
obvious from reading the code. Format: **decision statement in bold** followed
by rationale.

## Error Handling

How errors surface and degrade. Only include if non-obvious.

## Out of Scope

What was explicitly deferred. Useful for future agents picking up related work —
they know what was considered and intentionally skipped.

## Test Coverage

What's tested and how. Module-level summary, not individual test names. Mention
fixture patterns if relevant.
```

## What to Keep

- What changed, per module/area
- Key architectural decisions with rationale
- Error handling behavior
- Out of scope / explicitly deferred items
- Test coverage summary
- Anything a future developer or agent needs to understand _why_ things are the
  way they are

## What to Cut

- User stories (planning artifact, not reference)
- Step-by-step implementation instructions (the code is the implementation)
- Per-file modification lists with line numbers (stale immediately)
- Verification checklists (one-time use)
- Brainstorming alternatives that weren't chosen (unless the "why not" is
  valuable)
- Review report findings that were addressed (they're in the code now)
- Version history commentary (`v1 had X, v2 changed to Y`)

## Tone

Write for someone who needs to modify this feature in 6 months. They want to
know what exists, where it lives, why it's shaped that way, and what was
intentionally left out. They don't need to know the journey — just the
destination.

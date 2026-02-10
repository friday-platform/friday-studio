---
name: remembering-learnings
description: >
  Mines agent learnings from commit messages, team lead notes, and review docs,
  then curates them into CLAUDE.md. Reads Key Learnings from commit footers,
  docs/learnings/*.md files, and docs/reviews/*.md findings. Deduplicates,
  filters for generalizability, and presents the diff for user approval.
  Triggers on "flush learnings", "update claude.md from learnings",
  "what did agents learn".
argument-hint: "[branch-name]"
---

# Remember Learnings

Mine what agents learned and curate it into CLAUDE.md.

## Pre-fetched Context

Commit log with bodies (for Key Learnings extraction):

!`git log main..HEAD --format="---commit---%n%H%n%s%n%b" 2>/dev/null || echo "No commits found"`

## Input

$ARGUMENTS

Parse for:
- **Branch name** — defaults to current branch
- **Base branch** — defaults to `main`

## Phase 1: Mine Sources

Collect raw learnings from three sources.

### 1a: Commit Footers

Parse the pre-fetched commit log above. Extract entries from `Key Learnings:`
lines in the Progress footer. Skip commits where Key Learnings is "None" or
absent.

For each learning, note the commit subject and scope for context.

### 1b: Team Lead Notes

Read all files matching `docs/learnings/*.md`. These are unstructured notes from
team leads — observations about patterns, repeated mistakes, codebase quirks
discovered during diff review.

### 1c: Review Findings

Read all files matching `docs/reviews/*.md`. Extract findings that reveal
codebase patterns or gotchas — not task-specific bugs, but things that would
help future agents avoid the same issues.

Focus on:
- Findings that appeared in multiple reviews
- Architectural observations
- Pattern violations that indicate a missing rule
- Things marked as "Needs Decision" that were resolved (the resolution is the
  learning)

## Phase 2: Deduplicate & Filter

### Deduplication

Cluster related learnings. The same discovery often appears in multiple places:
a commit footer, a review finding, and a team lead note. Merge these into a
single learning with the best phrasing.

### Filter: The Future Agent Test

For each learning, ask: **"If a fresh agent started working on this codebase
tomorrow, would knowing this save them from a mistake or speed up their work?"**

- **Yes** → Keep. This is CLAUDE.md material.
- **No** → Discard. It's task-specific context that doesn't generalize.

Discard:
- What was changed (that's in the code)
- Task-specific details ("endpoint needed X field")
- Things obvious from reading the codebase
- Temporary workarounds that have been resolved

Keep:
- API/library behavior gotchas
- Codebase patterns that surprised agents
- Things that broke in non-obvious ways
- Mock/test patterns unique to this codebase
- Rules that agents keep violating (suggests CLAUDE.md gap)

## Phase 3: Curate into CLAUDE.md

Read CLAUDE.md thoroughly. Understand its current structure, sections, and tone.

For each surviving learning, determine placement:

1. **Merge** — The learning reinforces or extends an existing entry. Update the
   existing text.
2. **Insert** — The learning is new. Place it in the most relevant existing
   section.
3. **Replace** — The learning supersedes a stale entry. Replace it.
4. **New section** — Only if multiple related learnings don't fit any existing
   section. Rare.

### Writing Style

Match CLAUDE.md's existing tone: terse, imperative, developer-to-developer.

- One line per rule/gotcha where possible
- Include the "why" only when the rule isn't self-evident
- Use the same formatting patterns as existing entries

### Present to User

Show the proposed diff before writing. Format as:

```
## Proposed CLAUDE.md Changes

### [Section Name]

- Added: "learning text here" (source: commit abc123 / review / team lead)
- Updated: "existing text" → "updated text" (source: ...)
- Removed: "stale text" (reason: superseded by ...)

N additions, N updates, N removals.
```

Wait for user approval before writing.

## Phase 4: Clean Up

After approved changes are written:

1. Delete all `docs/learnings/*.md` files (these are consumed)
2. Do NOT delete `docs/reviews/*.md` (these are reference material)
3. Commit via committing: `chore(meta): flush agent learnings to CLAUDE.md`

## Rules

- Never append blindly — curate placement in existing sections
- Never make CLAUDE.md verbose — one line per rule when possible
- Never add learnings that are obvious from reading the code
- Never force learnings — if nothing passes the filter, report "No actionable
  learnings found" and stop
- Always present the diff before writing
- Always match CLAUDE.md's existing tone and formatting

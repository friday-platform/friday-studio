---
name: committing
description: Formats conventional commit messages with structured progress footer. Loaded when making commits as part of task execution — used by ralph, polishing, implementing-tasks, and any other skill that commits code.
---

# Commit

## Message Structure

```
<type>(<scope>): <subject>

<body - what and why>

## Progress
- Task: <task ID and subject>
- Decisions: <key decisions and reasoning>
- Key Learnings: <what you found that would be helpful to future teammates>
- Files: <files changed>
```

## Types

`feat`, `fix`, `refactor`, `test`, `docs`, `chore`

## Rules

- **Subject:** imperative mood, lowercase, no period, <72 chars
- **Scope:** module or area affected (e.g., `auth`, `storage`, `cli`)
- **Body:** explain *what* changed and *why* — not *how*
- **Progress footer:** always include when working on a task. Omit only for
  trivial standalone commits (lint fixes, typos)
- **One logical change per commit** — don't bundle unrelated changes
- **Key Learnings:** non-obvious discoveries a future agent would benefit from.
  Good: API behavior gotchas, codebase patterns that surprised you, things that
  broke in a non-obvious way, mock/test quirks unique to this area.
  Bad: what you changed (that's the body), task-specific details, things obvious
  from reading the code.
  If nothing non-obvious was learned, write "None" — don't force it.
  These get mined by `remembering-learnings` and curated into CLAUDE.md.
- **Shared worktrees:** `git add` picks up other teammates' staged files —
  always use `git add <specific-files>`, never `git add .` or `git add -A`.
  Safest: `git commit -- <specific-files>` bypasses staging area entirely

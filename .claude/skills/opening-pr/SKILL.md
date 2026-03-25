---
name: opening-pr
description: >
  Opens a pull request with a concise description of changes and rationale.
  Triggers on "open a PR", "create PR", "opening-pr", "land this".
argument-hint: "[additional context for PR description]"
---

# Open PR

Open a PR with a concise description of everything changed and, importantly,
_why_.

## Pre-fetched Context

Commit log:

!`git log main..HEAD --oneline 2>/dev/null || echo "No commits found"`

Changed files:

!`git diff --stat main...HEAD 2>/dev/null || echo "No diff found"`

## Input

$ARGUMENTS

## Process

1. Review the pre-fetched commit log and changed files above
2. Read any plan docs in `docs/plans/` that relate to the branch
3. Draft a PR title (<70 chars) and description
4. Push and create the PR

## PR Format

```markdown
{emoji} {micro-poem relevant to the changes}

## Summary

{2-3 bullet points: what changed and why}

## Test Plan

{How this was tested — commands run, scenarios verified}
```

### Micro-poem forms

Pick one that fits the vibe of the PR. Surprise me.

| Form | Structure | Emoji | Best for |
|------|-----------|-------|----------|
| **Haiku** | 5-7-5 syllables, nature imagery | 🌸 | Clean, elegant changes |
| **Senryū** | 5-7-5 syllables, human folly | 😏 | Fixing dumb bugs, refactors born of regret |
| **Epigram** | 2-4 lines, witty and pointed | 🗡️ | Deletions, simplifications, hard truths |
| **Six-word memoir** | Exactly 6 words, tells a story | 📖 | Big impact in small diff |
| **Limerick** | AABBA rhyme, 5 lines | 🎪 | Absurd bugs, entertaining fixes |
| **Koan** | Zen riddle, no answer expected | 🪷 | Cursed PRs, race conditions, mysteries |

## Rules

- Title: imperative mood, <70 chars, describes the outcome
- Description: focus on _why_, not _what_ (the diff shows the what)
- Include the micro-poem — it's tradition
- If $ARGUMENTS contains additional context, incorporate it into the description

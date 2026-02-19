# Experiment Log Template

Write to `docs/experiments/{agent-name}.md`. One file per agent being tuned.
Copy this structure and fill in the sections.

---

```markdown
# {Agent Display Name} Tuning

Agent: `{path/to/agent/source.ts}`
Eval: `{path/to/eval/file.ts}`

## Problem

{1-2 sentences describing the failure mode you're tuning against.}

## Current State

Tag: `{latest-accepted-tag}` — {passed}/{total} passing.

Remaining failures:
- `{eval/case/name}` — {why it fails}

## Learnings

{Number these. Each learning has what you observed and the generalizable
takeaway. Tie back to the iteration that produced it.}

1. **{Short title}** (from round {N}): {What you observed — the specific failure
   mode or model behavior.} Takeaway: {The generalizable principle — what to do
   differently next time.}

## Iteration Log

### Round {N} — {short description} ({YYYY-MM-DD})

**Tag:** `{tag-used-for-this-run}`

**Hypothesis:** {What you think is causing the failure and why this change should
fix it.}

**Change:** {What you changed and where. Be specific enough that someone can
understand without reading the diff.}

**Result:** {before-pass-rate} → {after-pass-rate}. {N} improved, {N} regressed.

Improved: `{eval/case/a}`, `{eval/case/b}`
Regressed: {none, or list with reasons}

**Decision:** keep | revert | iterate
```

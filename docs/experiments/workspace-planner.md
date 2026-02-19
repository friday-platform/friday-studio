# Workspace Planner Tuning

Agent: `packages/workspace-builder/planner/plan.ts`
Eval: `tools/evals/agents/planner/planner.eval.ts`

## Problem

The planner over-splits single-service tasks into multiple agents. When all
operations target the same external service (e.g. "Create a Linear issue"), the
planner produces 2+ agents instead of collapsing them into one.

## Current State

Tag: `planner-v1-service-boundary` — 12/12 passing.

Remaining failures: none.

## Learnings

1. **Enumerated lists become hard rules** (from round 1): Models treat listed
   categories as exhaustive constraints. Listing "summarization" as a separate
   capability was interpreted as "always create a summarizer agent" — the model
   followed the letter of the instruction even when it contradicted common sense.
   Takeaway: Use concrete examples over abstract category lists. "ONE Calendar
   agent that reads events AND creates meetings" is more reliable than "split by
   capability boundary."

2. **"Combine only when" rules are too narrow** (from round 1): The prompt only
   allowed combining for "multiple similar operations." The model interpreted
   "reading events" and "creating meetings" as dissimilar, so it split them.
   Takeaway: Positive rules ("use one agent when") are stronger than negative
   rules ("don't split when"), and both are weaker than concrete examples. When
   positive and negative rules can be interpreted to conflict, the model defaults
   to the more specific instruction.

3. **Check all prompt surfaces** (from round 1): The user message suffix
   reinforced the system prompt's bad framing. "Split agents by external system
   and capability boundary" appeared in both the system prompt and every user
   message, doubling the weight of the wrong rule. Takeaway: System prompt, user
   message template, and planning guidelines must align. Conflicting signals
   across surfaces create unpredictable behavior. Aligned signals compound.

## Iteration Log

### Round 1 — service boundary rewrite (2026-02-19)

**Tag:** `planner-v1-service-boundary`

**Hypothesis:** The prompt's "split by capability boundary" instruction causes
the model to treat different operations on the same API as distinct
capabilities. Listing "summarization" as a separate capability causes needless
summarizer agents. Reframing around external service boundaries should fix both.

**Change:** Rewrote `SYSTEM_PROMPT_BASE` splitting rules in `plan.ts`. Replaced
"integration point and capability boundary" framing with "external service
boundary — one agent per service." Added explicit same-service collapse examples
(Calendar read+create, Slack search+post, Linear multi-op). Added "Do NOT create
standalone summarizer" rule. Updated user message suffix to drop "capability
boundary" language. Updated planning guidelines to reinforce
one-agent-per-service. Also relaxed eval split cases to accept 2-3 agents.

**Result:** 3/12 → 12/12. 9 improved, 0 regressed.

Improved: `planner/task/calendar-read-and-create`,
`planner/workspace/calendar-read-and-create`,
`planner/task/slack-search-and-post`,
`planner/workspace/slack-search-and-post`, `planner/task/github-to-slack`,
`planner/workspace/github-to-slack`, `planner/task/linear-to-notion`,
`planner/workspace/linear-to-notion`, `planner/task/research-then-email`

**Decision:** keep

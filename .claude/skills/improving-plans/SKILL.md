---
name: improving-plans
description: Critiques and reviews an existing plan, presents findings interactively, and outputs an improved version with a summary of changes. Activates when iterating on a design doc or plan that needs a second pass, or on "review this plan", "critique this design", "improve this spec".
argument-hint: "[plan file path]"
---

You are running a design review of a plan that was generated as the result of a
brainstorm. Your overall goal is to review the design and work collaboratively
with the user to generate an improved version.

## Input

Additional details:

$ARGUMENTS

Parse this for:

- **Plan path** - path to the architecture/design document (required)

If empty or path doesn't exist, abort with: "Usage: /design-review
<path-to-plan.md>"

## Version Detection

Detect the current version from the input filename:

- `foo.md` → current: v1, output: `foo.v2.md`
- `foo.v2.md` → current: v2, output: `foo.v3.md`
- `foo.v3.md` → current: v3, output: `foo.v4.md`
- Pattern: `*.vN.md` where N is a number

Store:

- `CURRENT_VERSION` - the version number (1 if no version suffix)
- `NEXT_VERSION` - CURRENT_VERSION + 1
- `BASE_NAME` - filename without version suffix (e.g., `foo` from `foo.v3.md`)
- `OUTPUT_PATH` - `{dir}/{BASE_NAME}.v{NEXT_VERSION}.md`

## Phase 1: Read the Plan and all Reports

Read the plan document.

Read ALL of the relevant review reports in the reviews/ directory. They are in
the format: `reviews/{BASE_NAME}-v{VERSION}-review-report.md`

## Phase 2: Deep Context Gathering

Before reviewing, **thoroughly explore** the codebase to understand the problem
space. It's much cheaper to iterate in "plan space" than implementation space.

Investigate (use Read, Glob, Grep, etc.):

- **All referenced files/paths** in the plan - read them
- **Related code** if implementation paths are mentioned - understand current
  state
- **Other docs in same directory** - sibling plans, related specs
- **Existing implementations** of similar patterns in the codebase
- **Tests** that might reveal edge cases or assumptions
- **Any linked issues/PRs** mentioned in the plan

Go deep. Follow threads. Different reviewers exploring different paths is a
feature, not a bug.

With your gathered context, think hard about what could be improved, fixed,
tweaked, revised, or amended to make the system:

- Simpler
- More reliable
- More intuitive
- More user-friendly and ergonomic for both humans AND coding agents
- Better at achieving its stated goals

## Review Dimensions

### Clarity & Completeness

- Are the goals clearly stated?
- Are there unstated assumptions that should be explicit?
- Missing edge cases or failure modes?
- Gaps in the design that would cause implementers to guess?

### Architectural Soundness

- Does the structure match the problem shape?
- Are responsibilities well-separated?
- Are there unnecessary layers of indirection?
- Could this be simpler without losing capability?

### Practical Implementation

- Will this actually work in practice?
- What's the hardest part to implement correctly?
- Where will bugs likely hide?
- What will confuse future maintainers?
- If the plan involves database tables with user-scoped data: are RLS policies
  specified? Load the `database-rls` skill to verify the policy design.

### API/Interface Design

- Is the interface intuitive?
- Does it follow principle of least surprise?
- Are error states handled gracefully?
- Would an AI agent understand how to use this?

### Alternative Approaches

- What other ways could this problem be solved?
- What are the tradeoffs of the chosen approach vs alternatives?
- Is there a simpler approach that achieves 80% of the value?

Your Requirement:

Come up with a maximum of 5 NEW ideas, proposed changes, or thoughts about the
current plan.

- If an idea retreads something that was already covered in a previous review
  report, discard it.
- You do not NEED to come up with 5 ideas, proposed changes, or thoughts. Do not
  try to gold plate the plan.

## Phase 3: Interactive Review and Discussion

For each of the ideas, proposed changes, or thoughts about the current plan:

- Propose 2-3 different approaches with trade-offs
- Present options conversationally with your recommendation and reasoning
  - Use the AskUserQuestion tool if it's available
- Lead with your recommended option and explain why

## Phase 4: Update & Store

Output TWO files:

1. The v{NEXT_VERSION} Plan

**Path:** Use the computed `OUTPUT_PATH`

- `docs/plans/foo.md` → `docs/plans/foo.v2.md`
- `docs/plans/foo.v2.md` → `docs/plans/foo.v3.md`
- `design/architecture.v5.md` → `design/architecture.v6.md`

Write the complete enhanced plan (not diffs - the full document). Add a header:

```markdown
<!-- v{NEXT_VERSION} - [date] - Generated via /improving-plans from [original-path] -->
```

2. The Review Report

**Path:** `reviews/{BASE_NAME}-v{CURRENT_VERSION}-review-report.md`

Include:

- The full analysis (agree/disagree/caveats/overlap). This is important for
  future reviews so the same thing isn't reviewed again.
- Any unresolved questions

---
description: Deep design critique - spawns Opus to stress-test a plan, then synthesizes findings into an improved version
---

You are running a two-pass design critique. First, a subagent deeply analyzes the plan. Then you synthesize findings, apply low-stakes fixes directly, and surface major decisions to the user.

## Input

$ARGUMENTS

Parse for:
- **Plan path** - path to the architecture/design document (required)

If empty or path doesn't exist, abort with: "Usage: /design-critique <path-to-plan.md>"

## Version Detection

Detect the current version from the input filename:
- `foo.md` → current: v1, output: `foo.v2.md`
- `foo.v2.md` → current: v2, output: `foo.v3.md`
- Pattern: `*.vN.md` where N is a number

Store:
- `CURRENT_VERSION` - version number (1 if no version suffix)
- `NEXT_VERSION` - CURRENT_VERSION + 1
- `BASE_NAME` - filename without version suffix
- `OUTPUT_PATH` - `{dir}/{BASE_NAME}.v{NEXT_VERSION}.md`

## Phase 1: Read the Plan

Read the plan document. That's it. The subagent will do its own deep exploration.

## Phase 2: Spawn Critique Agent

Spawn a **single opus agent** with the following prompt:

```
You are a design critic. Your job is to make this plan better by finding everything wrong with it - or confirming it's solid.

## Mindset

Adopt the stance of an adversarial collaborator. You WANT this plan to succeed, which means you must ruthlessly expose weaknesses now - in "plan space" where changes are cheap - rather than letting them surface during implementation.

BUT: If the plan is fundamentally sound, say so. Don't manufacture concerns. A "this is solid, minor nits only" verdict is valid and valuable. Overcriticism wastes everyone's time.

Channel two perspectives as you work:

**The Skeptic** - Why won't this work? What's being hand-waved? Where are the load-bearing assumptions that nobody's examined? What happens when those assumptions break? What's the hardest part, and is it proportionally detailed?

**The Simplifier** - What can be removed? What's speculative generality? Is there an 80/20 solution hiding inside this 100% solution? What would a senior engineer delete on first read?

## The Plan

Path: [plan path]
Content:
---
[full plan content]
---

## Your Process

### Step 1: Deep Context Gathering

Before critiquing, **thoroughly explore** the codebase. Don't just read referenced files - follow threads, understand the ecosystem this plan lives in.

Investigate:
- **All files/paths referenced** in the plan
- **Current implementations** of related functionality
- **Sibling docs** in the same directory
- **Tests** that reveal edge cases and assumptions
- **Similar patterns** elsewhere in the codebase - how were they solved?
- **Recent git history** on related files - what problems have been encountered?

Spend serious time here. Your critique is only as good as your context.

### Step 2: Validate Against Reality

With context loaded, stress-test the plan:

1. **Trace through concrete scenarios.** Pick 3-5 specific use cases and mentally execute them against the design. Where does the logic break down? What paths weren't considered?

2. **Identify load-bearing assumptions.** What must be true for this design to work? Are those assumptions documented? Validated? What happens when they're violated?

3. **Look for the hard parts.** What's the single hardest thing to get right in this implementation? Is the plan proportionally detailed there, or does it hand-wave the hard parts?

4. **Check for missing error handling.** What can fail? Is each failure mode addressed? Or is the plan assuming happy path only?

5. **Evaluate against alternatives.** What other approaches could solve this problem? Why is this approach better? Is the plan aware of its tradeoffs?

### Step 3: Structured Critique

First, make an overall assessment:

#### Overall Verdict

One of:
- **Solid** - Plan is fundamentally sound. Minor improvements possible but no blockers.
- **Needs Work** - Good bones, but significant gaps or issues to address before implementation.
- **Rethink** - Fundamental problems that require stepping back and reconsidering the approach.

Then organize findings:

#### Will Break
Specific, concrete things that will not work as specified. Include:
- **What** will break
- **Why** it will break (mechanism)
- **When** it will break (scenario/conditions)
- **Evidence** from codebase exploration

#### Underspecified
Areas where implementers will have to guess. Different guesses = inconsistency.

#### Unnecessary Complexity
Things that could be simplified or removed. For each:
- What's the simpler alternative?
- What value would be lost? Is that value actually needed now?

#### Missing Considerations
Important aspects not addressed: error handling, edge cases, migration, observability, performance, security.

#### Minor Improvements
Low-stakes fixes that don't require human judgment - cleaner wording, better naming, small clarifications.

### Step 4: Propose Improvements

For each substantive issue, provide a concrete fix. Don't just criticize - show what better looks like.

Categorize each fix:

**[LOW-STAKES]** - Can be applied directly without human review. Wording improvements, obvious clarifications, typo-level stuff.

**[NEEDS-DECISION]** - Requires human judgment. Architectural choices, tradeoffs, scope decisions.

Format:

#### [Issue Title] [LOW-STAKES|NEEDS-DECISION]

**Problem:** [What's wrong and why it matters]

**Evidence:** [What you found in the codebase that supports this]

**Current:**
```
[relevant section from plan]
```

**Proposed:**
```
[improved version]
```

**Why this is better:** [specific reasoning]

---

### Step 5: Final Assessment

1. **Strongest parts** - What's good and should NOT change? (Protects against overcorrection)

2. **Biggest risk** - If implemented as-is, what's most likely to bite?

3. **Unresolved questions** - What needs human judgment? What can't be resolved through analysis?

## Output

Your response MUST include:

1. **Context explored** - What files did you read? What shaped your critique?

2. **Overall verdict** - Solid / Needs Work / Rethink, with 2-3 sentence justification

3. **Structured critique** - All categories above, with evidence and proposed fixes clearly tagged [LOW-STAKES] or [NEEDS-DECISION]

4. **Unresolved questions** - Issues requiring human input

5. **Strongest parts** - What to preserve
```

## Phase 3: Synthesize & Apply

When the subagent returns, YOU (the orchestrator) do additional work:

### 3a: Review the Critique

Read through the subagent's findings. Based on the overall verdict:

- **Solid** - Apply all [LOW-STAKES] fixes, surface any [NEEDS-DECISION] items to user
- **Needs Work** - Apply [LOW-STAKES] fixes, but hold on [NEEDS-DECISION] until user weighs in
- **Rethink** - Don't write anything yet. Present the critique and ask user how to proceed.

### 3b: Do Your Own Validation

With the critique in hand, do a quick pass yourself:
- Read any files the subagent flagged that seem important
- Verify the proposed fixes actually make sense
- Check if any [NEEDS-DECISION] items are actually obvious enough to just fix

### 3c: Create the Updated Plan

If verdict is Solid or Needs Work:
1. Start with the original plan
2. Apply all [LOW-STAKES] fixes
3. For [NEEDS-DECISION] items, add inline comments: `<!-- DECISION NEEDED: [summary] -->`
4. This becomes v{NEXT_VERSION}

## Phase 4: Write Outputs

### 1. The v{NEXT_VERSION} Plan

**Path:** `{OUTPUT_PATH}`

Add header:
```markdown
<!-- v{NEXT_VERSION} - [date] - Generated via design-critique from [original-path] -->
```

Write the updated plan with [LOW-STAKES] fixes applied and [NEEDS-DECISION] items marked.

### 2. The Critique Report

**Path:** `reviews/{BASE_NAME}-v{NEXT_VERSION}-critique.md`

Create the directory if needed. Include:
- Overall verdict
- Context explored
- Full structured critique (preserve all the subagent's reasoning)
- Unresolved questions
- Strongest parts

## Phase 5: Report to User

Tell the user:

1. **Verdict:** [Solid/Needs Work/Rethink]
2. **Version:** v{CURRENT_VERSION} → v{NEXT_VERSION}
3. **Files written:** [paths]
4. **Applied directly:** [count] low-stakes improvements
5. **Needs your input:** [numbered list of NEEDS-DECISION items with brief context]
6. **Strongest parts:** [what NOT to change]

If there are [NEEDS-DECISION] items:
> "I've marked these in the plan with `<!-- DECISION NEEDED -->` comments. Want to discuss any of them, or should I make a call and proceed?"

If verdict was Rethink:
> "This plan has fundamental issues. Here's what the critique found: [summary]. Want to discuss alternatives before I write anything?"

## Error Handling

- Plan path doesn't exist → abort with usage message
- Plan empty/unreadable → abort
- Subagent fails → dump whatever partial response was received, ask user how to proceed
- Write fails → output content directly for user to save

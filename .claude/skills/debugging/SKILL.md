---
name: debugging
description: Provides a four-phase debugging framework (investigate, analyze, hypothesize, fix) ensuring root cause understanding before attempting solutions. Covers backward call-chain tracing, multi-component diagnostics, instrumentation, defense-in-depth, and architecture escalation. Especially valuable when encountering bugs, test failures, unexpected behavior, when under pressure, when "one quick fix" seems obvious, or when previous fixes haven't worked.
argument-hint: "[symptom or error]"
---

# Debug

**Core law: NO FIXES WITHOUT ROOT CAUSE UNDERSTANDING.**

If you haven't completed Phase 1, you cannot propose fixes. Symptom fixes are
failure.

## Phase 1: Investigate

### Read the Error

- Read error messages and stack traces _completely_
- Note line numbers, file paths, error codes
- Don't skip warnings — they're often the real clue

### Reproduce

- Can you trigger it reliably? What are the exact steps?
- If not reproducible → gather more data, don't guess

### Check What Changed

- `git diff`, recent commits, new dependencies, config changes
- Environmental differences (CI vs local, staging vs prod)

### Trace Data Flow Backward

When the error is deep in the call stack, trace backward to the source. Your
instinct is to fix where the error appears — resist it.

**Procedure:**

1. Find the line that errors
2. What called it? What value was passed?
3. Keep tracing up — where did the bad value originate?
4. Stop when you find the _original trigger_, not just the first caller

**When you can't trace manually, add instrumentation:**

```typescript
async function suspectFunction(input: string) {
	const stack = new Error().stack;
	console.error("DEBUG suspectFunction:", { input, cwd: process.cwd(), stack });
	// ... original code
}
```

Run, capture output, analyze: which caller? which value? which pattern?

### Map Component Boundaries

**For multi-component systems** (CI → build → deploy, API → service → DB):

Add diagnostic logging at each boundary _before_ proposing fixes:

```
For EACH component boundary:
  - Log what data enters
  - Log what data exits
  - Verify env/config propagation
  - Check state at each layer

Run once → evidence shows WHERE it breaks
THEN investigate that specific component
```

**Phase 1 is complete when you can state:** "The root cause is X because Y,
originating at Z."

## Phase 2: Analyze Patterns

1. Find working examples of similar code in the same codebase
2. If implementing a known pattern, read the reference implementation
   _completely_ — don't skim
3. List every difference between working and broken, however small
4. Map dependencies: what components, config, env does this assume?

## Phase 3: Hypothesize and Test

1. State one hypothesis clearly: "X is the root cause because Y"
2. Make the _smallest possible change_ to test it — one variable at a time
3. Did it work? → Phase 4. Didn't work? → new hypothesis, don't pile on fixes
4. If you don't understand something, say so. Don't pretend.

## Phase 4: Fix

1. **Write a failing test first** — simplest possible reproduction
2. **One fix, one change** — address the root cause identified in Phase 1. No
   "while I'm here" improvements.
3. **Verify** — test passes, no regressions, issue actually resolved
4. **Add defense-in-depth** — validate at each layer the bad data passed
   through, so the bug becomes impossible:
   - Input validation at entry points
   - Assertions at intermediate layers
   - Guards at the operation itself

### When the Fix Doesn't Work

- **< 3 attempts:** Return to Phase 1 with the new information
- **≥ 3 attempts:** STOP. This is an architecture problem, not a bug:
  - Each fix reveals new coupling or shared state
  - Fixes require "massive refactoring"
  - Fixing one place breaks another
  - **Discuss with the user before attempting more fixes**

## Red Flags — STOP and Return to Phase 1

If you catch yourself thinking any of these, you're skipping the process:

- "Quick fix for now, investigate later"
- "Just try changing X and see"
- "It's probably X, let me fix that"
- "I don't fully understand but this might work"
- "Let me add multiple changes and run tests"
- Proposing solutions before tracing data flow
- Listing fixes without prior investigation
- "One more attempt" when 2+ fixes have already failed

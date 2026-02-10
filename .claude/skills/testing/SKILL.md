---
name: testing
description: Covers testing philosophy, TDD workflow, anti-patterns, and Vitest-specific patterns. Loaded when writing, reviewing, or changing tests. Includes red-green-refactor methodology, mock boundaries, and Vitest gotchas. Also loaded by implementation and review skills.
user-invocable: false
---

# Testing

Test behavior, not mocks. Write the test first. Watch it fail. Write minimal
code to pass. If you didn't see it fail, you don't know it tests the right
thing.

**The killer question:** "What code path in MY codebase does this test exercise?"
If you can't point to a specific function, branch, or integration point — delete
the test.

## What Am I Doing?

| Activity | Load |
|----------|------|
| Writing implementation code | [references/tdd.md](references/tdd.md) — iron law, red-green-refactor, verification checklist |
| Writing or reviewing tests | [references/vitest-patterns.md](references/vitest-patterns.md) — table tests, mock boundaries, gotchas, matchers |
| Adding mocks or test-only methods | [references/anti-patterns.md](references/anti-patterns.md) — iron laws, pre-test checklist, examples |

## Iron Laws

```
1. NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
2. NEVER test mock behavior
3. NEVER add test-only methods to production classes
4. NEVER mock without understanding dependencies
5. NEVER test library behavior (Zod, TypeScript, etc.)
6. Apply Pareto: 20% of tests catch 80% of bugs
```

---
name: testing-anti-patterns
description: Use when writing or changing tests, adding mocks, or tempted to add test-only methods to production code - prevents testing mock behavior, production pollution with test-only methods, and mocking without understanding dependencies
---

# Testing Anti-Patterns

## Overview

Tests must verify real behavior, not mock behavior. Mocks are a means to
isolate, not the thing being tested.

**Core principle:** Test what the code does, not what the mocks do.

**Following strict TDD prevents these anti-patterns.**

## The Iron Laws

```
1. NEVER test mock behavior
2. NEVER add test-only methods to production classes
3. NEVER mock without understanding dependencies
4. Apply Pareto: 20% of tests catch 80% of bugs
```

## Anti-Pattern 1: Testing Mock Behavior

**The violation:**

```typescript
// ❌ BAD: Testing that the mock exists
test("renders sidebar", () => {
  render(<Page />);
  expect(screen.getByTestId("sidebar-mock")).toBeInTheDocument();
});
```

**Why this is wrong:**

- You're verifying the mock works, not that the component works
- Test passes when mock is present, fails when it's not
- Tells you nothing about real behavior

**your human partner's correction:** "Are we testing the behavior of a mock?"

**The fix:**

```typescript
// ✅ GOOD: Test real component or don't mock it
test("renders sidebar", () => {
  render(<Page />); // Don't mock sidebar
  expect(screen.getByRole("navigation")).toBeInTheDocument();
});

// OR if sidebar must be mocked for isolation:
// Don't assert on the mock - test Page's behavior with sidebar present
```

### Gate Function

```
BEFORE asserting on any mock element:
  Ask: "Am I testing real component behavior or just mock existence?"

  IF testing mock existence:
    STOP - Delete the assertion or unmock the component

  Test real behavior instead
```

## Anti-Pattern 2: Test-Only Methods in Production

**The violation:**

```typescript
// ❌ BAD: destroy() only used in tests
class Session {
  async destroy() { // Looks like production API!
    await this._workspaceManager?.destroyWorkspace(this.id);
    // ... cleanup
  }
}

// In tests
afterEach(() => session.destroy());
```

**Why this is wrong:**

- Production class polluted with test-only code
- Dangerous if accidentally called in production
- Violates YAGNI and separation of concerns
- Confuses object lifecycle with entity lifecycle

**The fix:**

```typescript
// ✅ GOOD: Test utilities handle test cleanup
// Session has no destroy() - it's stateless in production

// In test-utils/
export async function cleanupSession(session: Session) {
  const workspace = session.getWorkspaceInfo();
  if (workspace) {
    await workspaceManager.destroyWorkspace(workspace.id);
  }
}

// In tests
afterEach(() => cleanupSession(session));
```

### Gate Function

```
BEFORE adding any method to production class:
  Ask: "Is this only used by tests?"

  IF yes:
    STOP - Don't add it
    Put it in test utilities instead

  Ask: "Does this class own this resource's lifecycle?"

  IF no:
    STOP - Wrong class for this method
```

## Anti-Pattern 3: Mocking Without Understanding

**The violation:**

```typescript
// ❌ BAD: Mock breaks test logic
test("detects duplicate server", () => {
  // Mock prevents config write that test depends on!
  vi.mock("ToolCatalog", () => ({
    discoverAndCacheTools: vi.fn().mockResolvedValue(undefined),
  }));

  await addServer(config);
  await addServer(config); // Should throw - but won't!
});
```

**Why this is wrong:**

- Mocked method had side effect test depended on (writing config)
- Over-mocking to "be safe" breaks actual behavior
- Test passes for wrong reason or fails mysteriously

**The fix:**

```typescript
// ✅ GOOD: Mock at correct level
test("detects duplicate server", () => {
  // Mock the slow part, preserve behavior test needs
  vi.mock("MCPServerManager"); // Just mock slow server startup

  await addServer(config); // Config written
  await addServer(config); // Duplicate detected ✓
});
```

### Gate Function

```
BEFORE mocking any method:
  STOP - Don't mock yet

  1. Ask: "What side effects does the real method have?"
  2. Ask: "Does this test depend on any of those side effects?"
  3. Ask: "Do I fully understand what this test needs?"

  IF depends on side effects:
    Mock at lower level (the actual slow/external operation)
    OR use test doubles that preserve necessary behavior
    NOT the high-level method the test depends on

  IF unsure what test depends on:
    Run test with real implementation FIRST
    Observe what actually needs to happen
    THEN add minimal mocking at the right level

  Red flags:
    - "I'll mock this to be safe"
    - "This might be slow, better mock it"
    - Mocking without understanding the dependency chain
```

## Anti-Pattern 4: Incomplete Mocks

**The violation:**

```typescript
// ❌ BAD: Partial mock - only fields you think you need
const mockResponse = {
  status: "success",
  data: { userId: "123", name: "Alice" },
  // Missing: metadata that downstream code uses
};

// Later: breaks when code accesses response.metadata.requestId
```

**Why this is wrong:**

- **Partial mocks hide structural assumptions** - You only mocked fields you
  know about
- **Downstream code may depend on fields you didn't include** - Silent failures
- **Tests pass but integration fails** - Mock incomplete, real API complete
- **False confidence** - Test proves nothing about real behavior

**The Iron Rule:** Mock the COMPLETE data structure as it exists in reality, not
just fields your immediate test uses.

**The fix:**

```typescript
// ✅ GOOD: Mirror real API completeness
const mockResponse = {
  status: "success",
  data: { userId: "123", name: "Alice" },
  metadata: { requestId: "req-789", timestamp: 1234567890 },
  // All fields real API returns
};
```

### Gate Function

```
BEFORE creating mock responses:
  Check: "What fields does the real API response contain?"

  Actions:
    1. Examine actual API response from docs/examples
    2. Include ALL fields system might consume downstream
    3. Verify mock matches real response schema completely

  Critical:
    If you're creating a mock, you must understand the ENTIRE structure
    Partial mocks fail silently when code depends on omitted fields

  If uncertain: Include all documented fields
```

## Anti-Pattern 5: Testing Ceremony Over Substance (Pareto Violation)

**The violation:**

```typescript
// ❌ BAD: 3 tests for one fallback chain
it("extracts task from signalPayload.intent", () => { ... });
it("extracts task from signalPayload.body.task", () => { ... });
it("falls back to metadata.summary", () => { ... });

// ❌ BAD: Testing absence of non-existent feature
it("preserves full output without truncation", () => {
  const largeOutput = { data: "x".repeat(10000) };
  // There's no truncation code - what are we testing?
});

// ❌ BAD: Testing array initialization
it("returns empty errors array when no failures", () => {
  assertEquals(digest.errors, []);  // TypeScript already guarantees this
});
```

**Why this is wrong:**

- **Pareto principle:** 20% of tests catch 80% of bugs
- **Testing property access:** TypeScript validates at compile time
- **Testing absence of features:** You can't test that code doesn't exist
- **Excessive granularity:** One behavior split into many trivial tests

**The fix:**

```typescript
// ✅ GOOD: One test for the whole fallback chain
it("extracts input with fallback chain: intent -> body.task -> summary", () => {
  // intent wins
  assertEquals(buildDigest(withIntent).input.task, "Research AI");
  // body.task fallback
  assertEquals(buildDigest(withBodyTask).input.task, "Process doc");
  // summary fallback
  assertEquals(buildDigest(withSummary).input.task, "Summary");
});

// ✅ GOOD: Delete tests for non-existent behavior
// Don't test "no truncation" - there's no truncation code

// ✅ GOOD: Let integration test cover trivial paths
// Empty arrays, property access, etc. are covered by comprehensive tests
```

### Gate Function

```
BEFORE writing a test, ask:
  1. "Would this catch a bug that could actually happen?"
  2. "Is this testing real logic or just property access?"
  3. "Is there already a test that covers this path?"
  4. "Am I testing the absence of code that doesn't exist?"

IF answer to #1 is "no" or #2-4 is "yes":
  STOP - Don't write this test

Pareto checklist - HIGH VALUE tests:
  ✓ Edge cases that have caused bugs
  ✓ Complex branching logic
  ✓ Integration points between systems
  ✓ Error handling paths
  ✓ State transitions

Pareto checklist - LOW VALUE tests (skip these):
  ✗ Property access (TypeScript validates)
  ✗ Built-in methods (Array.filter works)
  ✗ Absence of features ("doesn't truncate")
  ✗ Each branch of trivial if/else
  ✗ Default values / empty arrays
```

### Consolidation Patterns

**Fallback chains:** One test with multiple assertions, not N tests

**Truth tables:** Parameterized tests for status derivation, type mapping, etc.

**Edge cases:** Combine related edge cases into one test when they exercise the
same code path

### Ratio Awareness

- `< 1:1` test-to-impl ratio - Probably under-tested
- `1:1 to 2:1` ratio - Healthy range
- `> 3:1` ratio - Review for ceremony/redundancy

## Anti-Pattern 6: Integration Tests as Afterthought

**The violation:**

```
✅ Implementation complete
❌ No tests written
"Ready for testing"
```

**Why this is wrong:**

- Testing is part of implementation, not optional follow-up
- TDD would have caught this
- Can't claim complete without tests

**The fix:**

```
TDD cycle:
1. Write failing test
2. Implement to pass
3. Refactor
4. THEN claim complete
```

## When Mocks Become Too Complex

**Warning signs:**

- Mock setup longer than test logic
- Mocking everything to make test pass
- Mocks missing methods real components have
- Test breaks when mock changes

**your human partner's question:** "Do we need to be using a mock here?"

**Consider:** Integration tests with real components often simpler than complex
mocks

## TDD Prevents These Anti-Patterns

**Why TDD helps:**

1. **Write test first** → Forces you to think about what you're actually testing
2. **Watch it fail** → Confirms test tests real behavior, not mocks
3. **Minimal implementation** → No test-only methods creep in
4. **Real dependencies** → You see what the test actually needs before mocking

**If you're testing mock behavior, you violated TDD** - you added mocks without
watching test fail against real code first.

### Ratio Awareness

- `< 1:1` test-to-impl ratio - Probably under-tested
- `1:1 to 2:1` ratio - Healthy range for most code
- `> 3:1` ratio - Review for verbosity/redundancy

### What to Test (High Value)

- Edge cases that have caused or could cause bugs
- Integration points between systems
- Complex branching logic (not simple if/else)
- Error handling paths
- State transitions

### What NOT to Test (Low Value)

- Property access (TypeScript validates at compile time)
- Built-in methods (sorting, array ops - they work)
- Absence of features ("this field is undefined when...")
- Each branch of trivial if/else chains

### Test Naming

Name tests by **behavior**, not internal function names:

- Good: `"filters code actions from agent step groups"`
- Bad: `"buildToolCallsByAgent returns empty map"`

### Consolidation Patterns

- Use parameterized tests for truth tables (status derivation, etc.)
- One comprehensive ordering test beats three partial ones
- Keep fixtures minimal - 50+ line setup for 2 assertions is a smell

## Quick Reference

| Anti-Pattern                    | Fix                                           |
| ------------------------------- | --------------------------------------------- |
| Assert on mock elements         | Test real component or unmock it              |
| Test-only methods in production | Move to test utilities                        |
| Mock without understanding      | Understand dependencies first, mock minimally |
| Incomplete mocks                | Mirror real API completely                    |
| Testing ceremony (Pareto)       | Ask "would this catch a real bug?"            |
| Tests as afterthought           | TDD - tests first                             |
| Over-complex mocks              | Consider integration tests                    |

## Red Flags

- Assertion checks for `*-mock` test IDs
- Methods only called in test files
- Mock setup is >50% of test
- Test fails when you remove mock
- Can't explain why mock is needed
- Mocking "just to be safe"
- Test-to-impl ratio > 3:1
- Multiple tests for one fallback chain
- Testing "doesn't truncate" (absence of code)
- Testing empty array initialization
- Testing property access TypeScript already validates

## The Bottom Line

**Mocks are tools to isolate, not things to test.**

If TDD reveals you're testing mock behavior, you've gone wrong.

Fix: Test real behavior or question why you're mocking at all.

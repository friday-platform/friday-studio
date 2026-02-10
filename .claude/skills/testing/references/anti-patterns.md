# Testing Anti-Patterns

Complete anti-patterns reference. Everything you need to identify and fix bad
tests without loading any other file.

---

## The Killer Question

**"What code path in MY codebase does this test exercise?"**

If you can't point to a specific function, branch, or integration point — delete
the test.

## Iron Laws

```
1. NEVER test mock behavior
2. NEVER add test-only methods to production classes
3. NEVER mock without understanding dependencies
4. NEVER test library behavior (Zod, TypeScript, etc.)
5. Apply Pareto: 20% of tests catch 80% of bugs
```

## Pre-Test Checklist

Run this before writing ANY test:

```
[] What app code does this exercise? (not library code)
[] Would this catch a bug that could actually happen?
[] Is there already a test covering this path?
[] Am I testing absence of code that doesn't exist?

If any answer is wrong → DON'T WRITE THE TEST
```

## Red Flags (grep for these in your output)

```
- Test file named `*.schema.test.ts` or `types.test.ts`
- Test names: "accepts valid input" / "rejects invalid input"
- Tests that only call `.parse()` with no app code
- Assertions on `*-mock` test IDs
- Methods only called in test files
- Mock setup >50% of test code
- Test-to-impl ratio > 3:1
```

## Quick Reference

| Anti-Pattern               | Fix                                   |
| -------------------------- | ------------------------------------- |
| Testing library behavior   | Delete — library already works        |
| Assert on mock elements    | Test real component or unmock          |
| Test-only production code  | Move to test utilities                |
| Mock without understanding | Understand deps first, mock minimally |
| Incomplete mocks           | Mirror real API completely            |
| Testing ceremony           | Ask "would this catch a real bug?"    |

## Ratio Awareness

- `< 1:1` test-to-impl — under-tested
- `1:1 to 2:1` — healthy
- `> 3:1` — review for ceremony

---

## Anti-Pattern 1: Testing Library Behavior

**Real example (deleted from this codebase):**

```typescript
// BAD: types.test.ts - EVERY test here just verifies Zod/TypeScript work
describe("CredentialSchema", () => {
  test("accepts credential without displayName", () => {
    const result = CredentialSchema.parse(baseCredential);
    expect(result.displayName).toBeUndefined();
  });

  test("accepts credential with displayName string", () => {
    const result = CredentialSchema.parse({
      ...baseCredential,
      displayName: "Work",
    });
    expect(result.displayName).toBe("Work");
  });

  test("rejects displayName that is not a string", () => {
    expect(() =>
      CredentialSchema.parse({ ...baseCredential, displayName: 123 })
    ).toThrow();
  });
});

describe("StorageAdapter interface", () => {
  test("includes updateMetadata method", () => {
    const mockAdapter: StorageAdapter = {/* full mock impl */};
    expect(typeof mockAdapter.updateMetadata).toBe("function");
  });
});
```

**Why delete:**

- Tests that `z.string().optional()` accepts strings/undefined — Zod works
- Tests that TypeScript interfaces have methods — TypeScript works
- Zero app code exercised
- If schema changes, test changes too — no protection

**The fix:** Delete. Route tests exercise schemas with real requests.

```typescript
// GOOD: Test YOUR code's behavior, not the library
test("PATCH /credentials/:id rejects invalid displayName", async () => {
  const res = await app.request("/v1/credentials/123", {
    method: "PATCH",
    body: JSON.stringify({ displayName: 123 }),
  });
  expect(res.status).toBe(400);
});
```

**Gate:**

```
BEFORE writing schema/type tests:
  Q: "What app code does this exercise?"

  IF "none - just the library" → DELETE
  IF "the schema definition" → DELETE (definition IS the spec)

  ONLY test: custom validation logic YOU wrote, transforms with business logic
```

---

## Anti-Pattern 2: Testing Mock Behavior

```typescript
// BAD: Testing that the mock exists
test("renders sidebar", () => {
  render(<Page />);
  expect(screen.getByTestId("sidebar-mock")).toBeInTheDocument();
});

// GOOD: Test real component or don't assert on mock
test("renders sidebar", () => {
  render(<Page />);
  expect(screen.getByRole("navigation")).toBeInTheDocument();
});
```

**Gate:**

```
BEFORE asserting on any element:
  Q: "Is this a mock element or real component output?"

  IF mock → DELETE assertion or unmock the component
```

---

## Anti-Pattern 3: Test-Only Methods in Production

```typescript
// BAD: destroy() only called in tests
class Session {
  async destroy() {
    await this._workspaceManager?.destroyWorkspace(this.id);
  }
}

// GOOD: Test utilities, not production class
// test-utils.ts
export async function cleanupSession(session: Session) {
  const workspace = session.getWorkspaceInfo();
  if (workspace) await workspaceManager.destroyWorkspace(workspace.id);
}
```

**Gate:**

```
BEFORE adding method to production class:
  Q: "Is this only used by tests?"

  IF yes → Put in test utilities instead
```

---

## Anti-Pattern 4: Mocking Without Understanding

```typescript
// BAD: Mock breaks test - it prevented config write test depends on
test("detects duplicate server", () => {
  vi.mock("ToolCatalog", () => ({
    discoverAndCacheTools: vi.fn().mockResolvedValue(undefined),
  }));
  await addServer(config);
  await addServer(config); // Should throw but won't!
});

// GOOD: Mock at correct level - preserve behavior test needs
test("detects duplicate server", () => {
  vi.mock("MCPServerManager"); // Just mock slow server startup
  await addServer(config);
  await addServer(config); // Duplicate detected
});
```

**Gate:**

```
BEFORE mocking:
  1. What side effects does the real method have?
  2. Does my test depend on any of them?

  IF yes → Mock lower (the slow/external part), not the method test needs
  IF unsure → Run with real impl first, observe, then add minimal mocks
```

---

## Anti-Pattern 5: Incomplete Mocks

```typescript
// BAD: Partial mock - missing fields downstream code uses
const mockResponse = {
  status: "success",
  data: { userId: "123" },
  // Missing: metadata.requestId that code accesses
};

// GOOD: Mirror real API completely
const mockResponse = {
  status: "success",
  data: { userId: "123" },
  metadata: { requestId: "req-789", timestamp: 1234567890 },
};
```

**Gate:**

```
BEFORE creating mock data:
  Check actual API response structure
  Include ALL fields, not just ones you think you need
```

---

## Anti-Pattern 6: Testing Ceremony (Pareto Violation)

```typescript
// BAD: 3 tests for one fallback chain
it("extracts from signalPayload.intent", () => { ... });
it("extracts from signalPayload.body.task", () => { ... });
it("falls back to metadata.summary", () => { ... });

// GOOD: One test, multiple assertions
it("extracts input with fallback: intent -> body.task -> summary", () => {
  assertEquals(buildDigest(withIntent).input.task, "Research AI");
  assertEquals(buildDigest(withBodyTask).input.task, "Process doc");
  assertEquals(buildDigest(withSummary).input.task, "Summary");
});
```

**HIGH VALUE tests:**

- Edge cases that have caused bugs
- Complex branching logic
- Integration points
- Error handling paths
- State transitions

**LOW VALUE (skip):**

- Property access (TypeScript validates)
- Built-in methods (Array.filter works)
- Absence of features ("doesn't truncate")
- Default values / empty arrays
- Library behavior

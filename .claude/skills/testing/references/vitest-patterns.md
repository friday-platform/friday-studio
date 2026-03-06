# Vitest Patterns

Complete Vitest reference. Table-driven tests, mock boundaries by layer,
gotchas, expressive matchers, and async patterns — everything you need without
loading any other file.

---

## The Real Test

Run this checklist after writing any test.

1. **What user-facing behavior does this protect?** Write it in one sentence. If
   you can't, the test is suspect.
2. **What's the mock ratio?** 90% code / 10% mocks = good. 50/50 = suspicious.
   10/90 = testing mocks.
3. **If you delete the implementation, why does this fail?** Wrong output = good.
   Mock not called = bad.
4. **Could a bug ship with this test passing?** If yes, find the gap.

---

## Table-Driven Tests

**Default to `test.each` when testing multiple inputs against the same logic.**
Reduces boilerplate, makes adding cases trivial, and keeps the test body focused
on the single assertion pattern.

### Object-based (preferred — self-documenting)

```typescript
const cases = [
  { name: "empty string", input: "", expected: false },
  { name: "valid email", input: "a@b.com", expected: true },
  { name: "missing @", input: "ab.com", expected: false },
  { name: "whitespace only", input: "  ", expected: false },
] as const;

test.each(cases)("isValidEmail: $name", ({ input, expected }) => {
  expect(isValidEmail(input)).toBe(expected);
});
```

### Tuple-based (compact — good for simple input/output pairs)

```typescript
test.each([
  ["empty", "", false],
  ["valid", "a@b.com", true],
  ["no @", "ab.com", false],
] as const)("isValidEmail: %s", (_label, input, expected) => {
  expect(isValidEmail(input)).toBe(expected);
});
```

### When to use table tests

- **Pure functions** with clear input/output mapping — the sweet spot
- **Validation logic** — enumerate valid/invalid cases
- **Error handling** — different inputs produce different error types
- **Edge cases** — group boundary conditions together

### When NOT to use table tests

- Different assertions per case (use separate tests)
- Complex setup that varies per case (table obscures what matters)
- Single case (just write a normal test)

---

## Mock Decision Framework

Ask in order. Stop at first "yes."

1. **Pure function?** → Don't mock. Test inputs/outputs directly.
2. **Slow? (network, disk, timers)** → Mock the I/O boundary, not business
   logic.
3. **Non-deterministic? (time, random)** → Mock the source, not the consumer.
4. **Unobservable side effect? (analytics, logging)** → Spy, don't mock.
5. **None of the above?** → Don't mock. You're mocking for convenience.

**Complexity smell:** If mock setup > test logic, you're either mocking too much
or writing an integration test.

---

## Mock Boundaries by Layer

### Routes/API (Hono handlers)

**Mock:** External services, databases **Keep real:** Request parsing, Zod
validation, response shaping

```typescript
// GOOD — Real validation, mocked persistence
test("rejects invalid payload", async () => {
  const res = await app.request("/users", {
    method: "POST",
    body: JSON.stringify({ name: "" }),
  });
  expect(res.status).toBe(400);
});

// BAD — Mocking the validator defeats the purpose
vi.mock("./schemas", () => ({ userSchema: { parse: vi.fn() } }));
```

**Gate:** "Am I testing HTTP behavior or business logic?" If business logic,
test the service directly.

### Domain Logic

**Mock:** Nothing. Should be pure. **If you need mocks:** Your domain has hidden
dependencies. Fix that.

```typescript
// GOOD — Pure, no mocks
test('calculates total with discount', () => {
  const result = calculateTotal({ items: [...], discount: 0.1 });
  expect(result).toBe(90);
});
```

**Gate:** "Why does pure logic need mocks?" Extract impure parts or pass
dependencies as arguments.

### Integration Points (MCP, storage, external APIs)

**Mock:** The external system **Keep real:** Your client code, error handling,
retries

```typescript
// GOOD — Mock transport, test client behavior
const mockTransport = createMockTransport();
mockTransport.onRequest('tools/list').respond({ tools: [...] });

const client = new MCPClient(mockTransport);
const tools = await client.listTools();
expect(tools).toHaveLength(3);

// BAD — Mocking your own client tests nothing
vi.mock('./mcpClient', () => ({ listTools: vi.fn() }));
```

**Gate:** "Am I mocking the boundary or my own code?" Mock boundaries only.

---

## Vitest Gotchas

### vi.mock factory must export every SUT import

`vi.mock` factory replaces the entire module — any export the SUT imports that's
missing from the factory silently becomes `undefined` at runtime (no import-time
error). Failures surface as `TypeError: X is not a function` deep in the call
stack.

```typescript
// BAD — SUT imports { doThing, doOther } but mock only provides doThing
vi.mock("./thing", () => ({ doThing: vi.fn() }));
// doOther is undefined at runtime — silent failure

// GOOD — Export everything the SUT needs
vi.mock("./thing", () => ({ doThing: vi.fn(), doOther: vi.fn() }));
```

### vi.mock() is hoisted

```typescript
// BAD — Won't work - vi.mock runs first
const mockFn = vi.fn();
vi.mock("./thing", () => ({ doThing: mockFn }));

// GOOD — Use vi.hoisted()
const mockFn = vi.hoisted(() => vi.fn());
vi.mock("./thing", () => ({ doThing: mockFn }));
```

### Forgetting to await async matchers

```typescript
// BAD — Silent false positive
expect(asyncFn()).resolves.toBe("value");

// GOOD — Always await
await expect(asyncFn()).resolves.toBe("value");
```

### Module cache leaks

```typescript
// BAD — Mock leaks across tests
vi.mock("./config");

// GOOD — Reset modules
beforeEach(() => vi.resetModules());

// Or use doMock for test-specific
vi.doMock("./config", () => ({ setting: "test-value" }));
const { thing } = await import("./thing");
```

### Default exports need explicit key

```typescript
// BAD — Missing default
vi.mock("./logger", () => ({ log: vi.fn() }));

// GOOD — Explicit default
vi.mock("./logger", () => ({ default: { log: vi.fn() } }));
```

### Mock state persists

```typescript
// BAD — Second assertion sees first call
expect(mockFn).toHaveBeenCalledWith("a");
expect(mockFn).toHaveBeenCalledWith("b");

// GOOD — Use specific matchers
expect(mockFn).toHaveBeenNthCalledWith(1, "a");
expect(mockFn).toHaveBeenNthCalledWith(2, "b");
```

### Object mutation breaks assertions

```typescript
// BAD — Object mutated after call
const obj = { status: "pending" };
doThing(obj);
obj.status = "done";
expect(mockFn).toHaveBeenCalledWith({ status: "pending" }); // Fails

// GOOD — Clone or assert on result
```

### vi.mock state persists across tests

```typescript
// BAD — Second test sees first test's mock config
describe("thing", () => {
  test("first", () => { mockFn.mockReturnValue("a"); /* ... */ });
  test("second", () => { /* mockFn still returns "a" */ });
});

// GOOD — Always reset in beforeEach
beforeEach(() => { vi.restoreAllMocks(); });
```

### vi.restoreAllMocks() doesn't clear vi.hoisted() mocks

`vi.restoreAllMocks()` restores original implementations but does **not** clear
call history on mocks created with `vi.hoisted()`. Tests leak state silently.

```typescript
// BAD — mockFn.mock.calls carries over between tests
const mockFn = vi.hoisted(() => vi.fn());
beforeEach(() => { vi.restoreAllMocks(); });

// GOOD — Explicitly reset each hoisted mock
const mockFn = vi.hoisted(() => vi.fn());
beforeEach(() => { mockFn.mockReset(); });
```

### mockResolvedValueOnce slots consumed by actual calls, not config

`mockResolvedValueOnce` slots are consumed by actual calls. If a code path
short-circuits (e.g., ternary skips a call), the slot isn't consumed and
subsequent calls get wrong return values.

```typescript
// BAD — if connectHttp is never called, its slot feeds the next connectStdio call
mockCreate.mockResolvedValueOnce(stdioClient);
mockCreate.mockResolvedValueOnce(httpClient); // skipped at runtime
mockCreate.mockResolvedValueOnce(stdioClient2); // gets httpClient instead

// GOOD — match mock slots to actual call order, not config order
mockCreate.mockResolvedValueOnce(stdioClient);
mockCreate.mockResolvedValueOnce(stdioClient2);
```

### vi.fn() needs type parameter for typed props

`vi.fn()` without a type parameter produces `Mock<Procedure | Constructable>`
which fails assignability to typed callback props (e.g., Svelte component props).

```typescript
// BAD — svelte-check fails: Mock<Procedure> is not assignable to (id: string | undefined) => void
const onchange = vi.fn();

// GOOD — Explicit type parameter
const onchange = vi.fn<(id: string | undefined) => void>();
```

### vi.mock doesn't intercept in Deno+vitest

`vi.mock("ai")` and similar module mocks don't reliably intercept in Deno's
vitest runtime. Use dependency injection instead of module mocking.

### expect.objectContaining doesn't assert undefined

```typescript
// BAD — Does NOT assert key is undefined
expect(result).toEqual(expect.objectContaining({ deletedField: undefined }));

// GOOD — Assert key is absent
expect(result).not.toHaveProperty("deletedField");
```

### Shared fixtures mutate across tests

```typescript
// BAD — Test A mutates registry, Test B sees mutated state
const registry = createRegistry();

// GOOD — Clone before each test
let registry: Registry;
beforeEach(() => { registry = structuredClone(baseRegistry); });
```

---

## Async Patterns

### Awaiting matchers

```typescript
await expect(fetchUser(1)).resolves.toEqual({ id: 1, name: "Alice" });
await expect(fetchUser(-1)).rejects.toThrow("Invalid ID");
```

### Specific rejection matching

```typescript
// GOOD — Specific
await expect(doThing()).rejects.toThrow("specific message");
await expect(doThing()).rejects.toThrow(CustomError);
await expect(doThing()).rejects.toMatchObject({ code: "NOT_FOUND" });

// BAD — Too loose
await expect(doThing()).rejects.toThrow();
```

### Polling with expect.poll()

```typescript
await expect.poll(() => getStatus()).toBe("complete");

await expect.poll(() => getQueueLength(), {
  interval: 100,
  timeout: 5000,
}).toBe(0);
```

### Fake timers

```typescript
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test("debounces input", async () => {
  const callback = vi.fn();
  const debounced = debounce(callback, 100);

  debounced();
  debounced();
  debounced();

  expect(callback).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(100);
  expect(callback).toHaveBeenCalledOnce();
});
```

### Ensuring assertions run

```typescript
test("handles callback", async () => {
  expect.assertions(2);

  await processWithCallback((result) => {
    expect(result.status).toBe("ok");
    expect(result.data).toBeDefined();
  });
});
```

---

## Expressive Matchers

Prefer semantic matchers over generic `toEqual()`. Better error messages,
clearer intent. **Default to the most expressive matcher available.**

### Primitives

```typescript
expect(result).toBeNull();
expect(result).toBeUndefined();
expect(isValid).toBe(true);
expect(count).toBeGreaterThan(0);
expect(score).toBeCloseTo(0.3, 5); // floating point
```

### Arrays

```typescript
expect(items).toHaveLength(3);
expect(items).toHaveLength(0);           // prefer over toBe([])
expect(users).toContainEqual({ id: 1, name: "Alice" }); // deep equality
expect(tags).toContain("important");     // reference/primitive
expect(items).toEqual(expect.arrayContaining([item1, item2])); // subset
```

### Objects

```typescript
// Partial match — assert on shape without over-specifying
expect(user).toMatchObject({
  id: "123",
  name: "Alice",
  role: "admin",
});

expect(response).toHaveProperty("data");
expect(response).toHaveProperty("data.users[0].name", "Alice");
expect(summary).not.toHaveProperty("secret");
```

### Strings

```typescript
expect(query).toContain("SELECT");
expect(query).not.toContain("DROP");
expect(email).toMatch(/^[^@]+@[^@]+$/);
expect(message).toMatch(expect.stringContaining("error"));
```

### Asymmetric matchers (use inside toEqual/toMatchObject)

```typescript
expect(event).toMatchObject({
  type: "user.created",
  payload: expect.objectContaining({ userId: expect.any(String) }),
  timestamp: expect.any(Number),
  metadata: expect.anything(), // any non-null/undefined
});
```

### Combining for readability

```typescript
// Structured assertion instead of scattered individual checks
expect(result).toMatchObject({
  items: [
    { id: "item-1", status: "active" },
    expect.objectContaining({ id: "item-2" }),
  ],
});
expect(result!.items).toHaveLength(2);
```

### expect.soft — collect failures without stopping

```typescript
// All assertions run even if early ones fail — useful for checking multiple
// properties where you want to see ALL failures at once
expect.soft(response.status).toBe(200);
expect.soft(response.headers["content-type"]).toContain("json");
expect.soft(response.body.items).toHaveLength(3);
```

### expect.assert — type narrowing

**`expect.assert` does TypeScript type narrowing.** Use it to narrow
discriminated unions and nullable types before asserting on properties.

```typescript
// Narrow a discriminated union
const result = processEvent(input);
expect.assert(result.type === "success");
// TypeScript now knows result is the success variant
expect(result.data.items).toHaveLength(3);

// Narrow away undefined — avoids `!` and `as` casts
const item = list.find(x => x.id === targetId);
expect.assert(item !== undefined);
expect(item.name).toBe("expected");

// Guard-throw also works for narrowing
if (!item) throw new Error("missing");
expect(item.name).toBe("expected");
```

### expect.unreachable — dead code assertion

```typescript
// Assert a code path should never execute
switch (status) {
  case "active": /* ... */ break;
  case "inactive": /* ... */ break;
  default: expect.unreachable("unexpected status");
}
```

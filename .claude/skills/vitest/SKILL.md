---
name: vitest
description: |
  Vitest testing patterns focused on testing real behavior, not mocks. Use when
  writing or reviewing tests. Covers: mock boundaries by layer (routes, domain,
  integration), Vitest-specific gotchas (hoisting, await, module cache), and
  async patterns. For testing philosophy and anti-patterns, see testing-anti-patterns skill.
---

# Vitest

For philosophy on what makes a good test, see the `testing-anti-patterns` skill.
This skill covers Vitest-specific patterns and gotchas.

## The Real Test

Run this checklist after writing any test.

### 1. What user-facing behavior does this protect?

Write it in one sentence. If you can't, the test is suspect.

- "Users can't create accounts with invalid emails"
- "Workspace cleanup happens when session ends"
- ~~"The mock returns the right value"~~
- ~~"The function calls the dependency"~~

### 2. What's the mock ratio?

```
90% your code, 10% mocks  → Good
50/50                     → Suspicious
10% your code, 90% mocks  → Testing mocks, not behavior
```

### 3. If you delete the implementation, why does this fail?

- Fails because mock wasn't called → **Bad.** Testing wiring.
- Fails because wrong output/state → **Good.** Testing behavior.

### 4. Could a bug ship with this test passing?

If yes, find the gap.

---

## When to Mock

Ask in order. Stop at first "yes."

**1. Pure function?**
→ Don't mock. Test inputs/outputs directly.

**2. Slow? (network, disk, timers)**
→ Mock the I/O boundary, not business logic.

```typescript
// ❌ Mocking too high
vi.mock('./userService', () => ({ getUser: vi.fn() }));

// ✅ Mock the fetch, keep service real
vi.mock('./http', () => ({ fetch: vi.fn() }));
```

**3. Non-deterministic? (time, random)**
→ Mock the source, not the consumer.

```typescript
vi.setSystemTime(new Date('2024-01-15'));
```

**4. Unobservable side effect? (analytics, logging)**
→ Spy, don't mock.

```typescript
const spy = vi.spyOn(analytics, 'track');
doThing();
expect(spy).toHaveBeenCalledWith('thing_done', { id: 123 });
```

**5. None of the above?**
→ Don't mock. You're mocking for convenience.

**Complexity smell:** If mock setup > test logic, you're either mocking too much
or writing an integration test.

---

## Layer Patterns

### Routes/API (Hono handlers)

**Mock:** External services, databases
**Keep real:** Request parsing, Zod validation, response shaping

```typescript
// ✅ Real validation, mocked persistence
test('rejects invalid payload', async () => {
  const res = await app.request('/users', {
    method: 'POST',
    body: JSON.stringify({ name: '' }),
  });
  expect(res.status).toBe(400);
});

// ❌ Mocking the validator defeats the purpose
vi.mock('./schemas', () => ({ userSchema: { parse: vi.fn() } }));
```

**Gate:** "Am I testing HTTP behavior or business logic?" If business logic,
test the service directly.

### Domain Logic

**Mock:** Nothing. Should be pure.
**If you need mocks:** Your domain has hidden dependencies. Fix that.

```typescript
// ✅ Pure, no mocks
test('calculates total with discount', () => {
  const result = calculateTotal({ items: [...], discount: 0.1 });
  expect(result).toBe(90);
});
```

**Gate:** "Why does pure logic need mocks?" Extract impure parts or pass
dependencies as arguments.

### Integration Points (MCP, storage, external APIs)

**Mock:** The external system
**Keep real:** Your client code, error handling, retries

```typescript
// ✅ Mock transport, test client behavior
const mockTransport = createMockTransport();
mockTransport.onRequest('tools/list').respond({ tools: [...] });

const client = new MCPClient(mockTransport);
const tools = await client.listTools();
expect(tools).toHaveLength(3);

// ❌ Mocking your own client tests nothing
vi.mock('./mcpClient', () => ({ listTools: vi.fn() }));
```

**Gate:** "Am I mocking the boundary or my own code?" Mock boundaries only.

---

## Vitest Gotchas

### vi.mock() is hoisted

```typescript
// ❌ Won't work - vi.mock runs first
const mockFn = vi.fn();
vi.mock('./thing', () => ({ doThing: mockFn }));

// ✅ Use vi.hoisted()
const mockFn = vi.hoisted(() => vi.fn());
vi.mock('./thing', () => ({ doThing: mockFn }));
```

### Forgetting to await async matchers

```typescript
// ❌ Silent false positive
expect(asyncFn()).resolves.toBe('value');

// ✅ Always await
await expect(asyncFn()).resolves.toBe('value');
```

### Module cache leaks

```typescript
// ❌ Mock leaks across tests
vi.mock('./config');

// ✅ Reset modules
beforeEach(() => vi.resetModules());

// Or use doMock for test-specific
vi.doMock('./config', () => ({ setting: 'test-value' }));
const { thing } = await import('./thing');
```

### Default exports need explicit key

```typescript
// ❌ Missing default
vi.mock('./logger', () => ({ log: vi.fn() }));

// ✅ Explicit default
vi.mock('./logger', () => ({ default: { log: vi.fn() } }));
```

### Mock state persists

```typescript
// ❌ Second assertion sees first call
expect(mockFn).toHaveBeenCalledWith('a');
expect(mockFn).toHaveBeenCalledWith('b');

// ✅ Use specific matchers
expect(mockFn).toHaveBeenNthCalledWith(1, 'a');
expect(mockFn).toHaveBeenNthCalledWith(2, 'b');
```

### Object mutation breaks assertions

```typescript
// ❌ Object mutated after call
const obj = { status: 'pending' };
doThing(obj);
obj.status = 'done';
expect(mockFn).toHaveBeenCalledWith({ status: 'pending' }); // Fails

// ✅ Clone or assert on result
```

---

## Expressive Matchers

Prefer semantic matchers over generic `toEqual()`. Better error messages, clearer
intent.

### Primitives

```typescript
// ❌ Generic
expect(result).toEqual(null);
expect(result).toEqual(undefined);
expect(isValid).toEqual(true);

// ✅ Semantic
expect(result).toBeNull();
expect(result).toBeUndefined();
expect(isValid).toBe(true);
```

### Arrays

```typescript
// ❌ Generic
expect(items.length).toEqual(3);
expect(items.length).toEqual(0);
expect(items.length > 0).toEqual(true);

// ✅ Semantic
expect(items).toHaveLength(3);
expect(items).toHaveLength(0);
expect(items.length).toBeGreaterThan(0);

// Array containment
expect(users).toContainEqual({ id: 1, name: 'Alice' }); // deep equality
expect(tags).toContain('important');                    // reference/primitive
```

### Objects

```typescript
// ❌ Multiple assertions for one object
expect(user.id).toEqual('123');
expect(user.name).toEqual('Alice');
expect(user.role).toEqual('admin');

// ✅ Single partial match
expect(user).toMatchObject({
  id: '123',
  name: 'Alice',
  role: 'admin',
});

// Property checks
expect(response).toHaveProperty('data');
expect(response).toHaveProperty('data.users[0].name', 'Alice');
expect(summary).not.toHaveProperty('secret');
```

### Strings

```typescript
// ❌ Generic
expect(query.includes('SELECT')).toEqual(true);
expect(query.includes('DROP')).toEqual(false);

// ✅ Semantic
expect(query).toContain('SELECT');
expect(query).not.toContain('DROP');

// Patterns
expect(email).toMatch(/^[^@]+@[^@]+$/);
```

### Combining for readability

```typescript
// ❌ Scattered assertions
expect(result).toBeDefined();
expect(result!.items.length).toEqual(2);
expect(result!.items[0]?.id).toEqual('item-1');
expect(result!.items[0]?.status).toEqual('active');

// ✅ Structured assertion
expect(result).toMatchObject({
  items: [
    { id: 'item-1', status: 'active' },
    expect.objectContaining({ id: 'item-2' }),
  ],
});
expect(result!.items).toHaveLength(2);
```

---

## Async Patterns

### Awaiting matchers

```typescript
await expect(fetchUser(1)).resolves.toEqual({ id: 1, name: 'Alice' });
await expect(fetchUser(-1)).rejects.toThrow('Invalid ID');
```

### Specific rejection matching

```typescript
// ✅ Specific
await expect(doThing()).rejects.toThrow('specific message');
await expect(doThing()).rejects.toThrow(CustomError);
await expect(doThing()).rejects.toMatchObject({ code: 'NOT_FOUND' });

// ❌ Too loose
await expect(doThing()).rejects.toThrow();
```

### Polling with expect.poll()

```typescript
await expect.poll(() => getStatus()).toBe('complete');

await expect.poll(() => getQueueLength(), {
  interval: 100,
  timeout: 5000,
}).toBe(0);
```

### Fake timers

```typescript
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test('debounces input', async () => {
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
test('handles callback', async () => {
  expect.assertions(2);

  await processWithCallback((result) => {
    expect(result.status).toBe('ok');
    expect(result.data).toBeDefined();
  });
});
```

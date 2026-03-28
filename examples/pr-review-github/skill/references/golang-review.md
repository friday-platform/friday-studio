# Go-Specific Review Criteria

Apply these criteria **in addition to** the general review criteria when the PR
contains `.go` files. Go has unique footguns around concurrency, error handling,
and implicit interfaces that generic reviews miss.

## 1. Concurrency

Go makes concurrency easy to start and hard to get right. Every goroutine in a
diff deserves scrutiny.

**Look for:**
- **Goroutine leaks** — goroutines launched without a cancellation path
  (`context.Context`, done channel, or parent lifetime). Every `go func()` must
  have a clear shutdown mechanism.
- **Missing context propagation** — blocking operations (network, DB, file I/O)
  without `context.Context` as the first parameter. This prevents graceful
  shutdown and timeout enforcement.
- **Unprotected shared state** — concurrent reads/writes to maps, slices, or
  struct fields without `sync.Mutex`, `sync.RWMutex`, or `atomic` operations.
  Maps are NOT safe for concurrent use.
- **Channel misuse** — sending on a closed channel (panics), unbuffered channels
  causing deadlocks, not draining channels before closing.
- **Missing `select` with `ctx.Done()`** — channel operations without a
  cancellation case block forever if the context is cancelled.
- **`sync.WaitGroup` misuse** — calling `wg.Add()` inside goroutines instead of
  before launch, or forgetting `defer wg.Done()`.
- **Race conditions** — shared state modified across goroutines without
  synchronization. Ask: "would `go test -race` catch this?"

**Severity guidance:**
- Goroutine leak or data race: **critical**
- Missing context propagation: **warning**
- Suboptimal sync primitive choice (Mutex vs RWMutex): **suggestion**

**Anti-patterns:**
```go
// BAD: goroutine leak — no way to stop this
go func() {
    for {
        process(item)
    }
}()

// GOOD: context-controlled lifetime
go func() {
    for {
        select {
        case <-ctx.Done():
            return
        case item := <-ch:
            process(item)
        }
    }
}()
```

```go
// BAD: concurrent map write (runtime panic)
var m = map[string]int{}
go func() { m["a"] = 1 }()
go func() { m["b"] = 2 }()

// GOOD: protected with mutex
var mu sync.Mutex
go func() { mu.Lock(); m["a"] = 1; mu.Unlock() }()
```

## 2. Error Handling

Go's explicit error handling is a strength, but only when done correctly.

**Look for:**
- **Ignored errors** — assigning to `_` without justification. Every error
  should be handled, logged, or explicitly documented as intentional to ignore.
- **Bare `fmt.Errorf()` without `%w`** — errors that don't wrap the original
  cause break `errors.Is()` and `errors.As()` chains.
- **`panic` for recoverable errors** — panic is for programmer bugs (invariant
  violations), not operational errors. Use `error` returns for anything that
  can fail at runtime.
- **Naked returns in error paths** — using named return values and naked
  `return` in functions with multiple return paths makes error flows hard to
  trace.
- **Error variable shadowing** — `:=` in inner scope creates a new `err` that
  doesn't propagate to the outer scope.
- **Missing `defer` cleanup** — resources (files, connections, locks) not
  released with `defer` on error paths.
- **Sentinel errors vs typed errors** — using string comparison
  (`err.Error() == "not found"`) instead of sentinel errors or type assertions.

**Severity guidance:**
- Ignored error that causes data loss or silent failure: **critical**
- Missing error wrapping: **warning**
- Naked returns in complex functions: **suggestion**

**Anti-patterns:**
```go
// BAD: lost error context
if err != nil {
    return fmt.Errorf("failed to save user")
}

// GOOD: wrapped with context
if err != nil {
    return fmt.Errorf("save user %s: %w", user.ID, err)
}
```

```go
// BAD: error shadowing
err := outerOperation()
if condition {
    result, err := innerOperation() // shadows outer err!
    // ...
}
// err here is still from outerOperation
```

## 3. Interface Design

Go interfaces are implicitly satisfied — this creates unique review concerns.

**Look for:**
- **Fat interfaces** — interfaces with many methods that force implementors to
  provide functionality they don't need. Prefer small, focused interfaces
  (1-3 methods).
- **Premature interface extraction** — defining interfaces before there are
  multiple implementations. "Accept interfaces, return structs" — but only when
  the interface serves testability or polymorphism.
- **Returning interfaces** — functions should return concrete types, not
  interfaces. Let the caller decide what interface to use.
- **Missing compile-time verification** — `var _ Interface = (*Struct)(nil)`
  pattern to ensure a struct satisfies an interface at compile time.
- **Interface pollution** — unnecessary interfaces that add indirection without
  value. If there's only one implementation and no tests mock it, it probably
  doesn't need an interface.

**Severity guidance:**
- Interface that prevents testability: **warning**
- Fat interface that violates ISP: **suggestion**
- Missing compile-time check: **nitpick**

## 4. Go-Specific Performance

**Look for:**
- **String concatenation in loops** — use `strings.Builder` instead of `+=`
  for building strings iteratively.
- **Unnecessary allocations** — preallocate slices with `make([]T, 0, cap)`
  when the size is known or estimable.
- **Pointer vs value receivers** — large structs should use pointer receivers;
  mixing pointer and value receivers on the same type is a code smell.
- **`defer` in tight loops** — `defer` runs at function exit, not loop
  iteration. Resources opened in loops need explicit cleanup.
- **Reflection in hot paths** — `reflect` is slow; use generics (Go 1.18+)
  or code generation instead.
- **Inefficient JSON handling** — `json.Marshal`/`Unmarshal` on every request;
  consider streaming with `json.Encoder`/`json.Decoder` or struct reuse.

**Severity guidance:**
- Allocation in hot loop causing GC pressure: **warning**
- Suboptimal but correct: **suggestion**

## 5. Go-Specific Testing

**Look for:**
- **Missing `-race` flag** — tests without race detector miss data races.
  Tests should pass with `go test -race`.
- **Non-table-driven tests** — repetitive test cases should use table-driven
  pattern with `t.Run` subtests.
- **Missing `t.Helper()`** — test helper functions without `t.Helper()` produce
  confusing failure line numbers.
- **`t.Errorf` vs `t.Fatalf`** — use `Fatalf` for setup failures that make
  subsequent assertions meaningless; use `Errorf` for assertion failures to see
  all failures at once.
- **Range variable capture in goroutines** — pre-Go 1.22, loop variable `tt`
  must be captured (`tt := tt`) before use in `t.Parallel()` subtests.
- **Missing cleanup** — test resources not cleaned up with `t.Cleanup()` or
  `defer`.

**Severity guidance:**
- Tests that mask races: **warning**
- Missing table-driven pattern: **suggestion**
- Missing `t.Helper()`: **nitpick**

## 6. Go Style & Conventions

**Look for:**
- **Exported names without doc comments** — all exported functions, types,
  and package-level variables must have godoc comments starting with the name.
- **Package naming** — packages should be lowercase, single-word, noun (not
  `util`, `common`, `base`, `helpers`).
- **`init()` function misuse** — `init()` makes startup order implicit and
  testing difficult. Prefer explicit initialization.
- **`context.TODO()` in production code** — indicates unfinished work; should
  be replaced with a real context.
- **Non-idiomatic naming** — `getId` instead of `getID`, `Url` instead of `URL`,
  `Json` instead of `JSON`. Go capitalizes acronyms: `HTTP`, `ID`, `URL`, `API`.
- **`else` after `if err != nil { return }` blocks** — the else is unnecessary
  since the if always returns. Reduces nesting.

**Severity guidance:**
- Missing exported doc comments: **suggestion**
- Non-idiomatic naming: **nitpick**

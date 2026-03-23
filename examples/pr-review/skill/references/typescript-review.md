# TypeScript-Specific Review Criteria

Apply these criteria **in addition to** the general review criteria when the PR
contains `.ts` or `.tsx` files. TypeScript's type system is powerful but has
sharp edges that generic reviews miss.

## 1. Type Safety

TypeScript's value is in its type system. Bypassing it defeats the purpose.

**Look for:**
- **`any` type usage** — `any` disables all type checking. Use `unknown` for
  truly unknown types and narrow with type guards, or use proper types. The only
  acceptable `any` is in type-assertion bridges (e.g., test fixtures before
  immediate Zod parse).
- **`as` type assertions** — `as` lies to the compiler. It doesn't perform
  runtime checks. Use Zod schemas for parsing untrusted data, type guards for
  narrowing, or refactor the type hierarchy. `as const` on literals is fine.
- **Non-null assertion (`!`)** — `obj!.prop` asserts non-null without checking.
  Use `?? fallback`, optional chaining `?.`, or `if (!x) throw` instead.
- **Missing discriminated union exhaustiveness** — `switch` on discriminated
  unions without a `default: never` check means new variants silently fall
  through.
- **Incorrect type narrowing** — using `typeof` when `instanceof` is needed,
  or vice versa. `typeof null === "object"` is a classic footgun.
- **Unsafe `JSON.parse`** — `JSON.parse()` returns `any`. Always follow with
  Zod validation or explicit type narrowing.
- **Index signature abuse** — `[key: string]: any` on interfaces disables type
  checking for all property access. Use `Record<string, unknown>` or explicit
  fields.

**Severity guidance:**
- `any` in production code path: **warning**
- `as` assertion hiding a real type mismatch: **critical**
- Missing exhaustiveness check: **warning**
- `!` assertion that could NPE at runtime: **warning**

**Anti-patterns:**
```typescript
// BAD: any disables all checking
function process(data: any) {
  return data.foo.bar; // no error even if foo is undefined
}

// GOOD: unknown + validation
function process(data: unknown) {
  const parsed = MySchema.parse(data);
  return parsed.foo.bar; // fully typed
}
```

```typescript
// BAD: as assertion hides bug
const user = response as User; // what if response is null?

// GOOD: runtime validation
const user = UserSchema.parse(response);
```

```typescript
// BAD: non-exhaustive switch
type Status = "active" | "inactive" | "pending";
switch (status) {
  case "active": return handle();
  case "inactive": return skip();
  // "pending" silently falls through!
}

// GOOD: exhaustive with never check
switch (status) {
  case "active": return handle();
  case "inactive": return skip();
  case "pending": return queue();
  default: {
    const _exhaustive: never = status;
    throw new Error(`Unhandled status: ${_exhaustive}`);
  }
}
```

## 2. Async & Promise Handling

**Look for:**
- **Unhandled promise rejections** — `async` functions called without `await`
  or `.catch()`. Unhandled rejections crash Node.js processes.
- **Missing `await`** — calling an async function without `await` means errors
  are silently swallowed and the caller proceeds before the operation completes.
- **Sequential awaits that could be parallel** — `await a(); await b()` when
  `a` and `b` are independent. Use `Promise.all([a(), b()])`.
- **`Promise.all` without error handling** — one rejection rejects the entire
  batch. Use `Promise.allSettled` when partial success is acceptable.
- **Floating promises** — promises created but never awaited, returned, or
  caught. Usually a bug.
- **Async in constructors** — constructors can't be async. Use factory pattern
  (`static async create()`) instead.
- **`void` return from async** — `async function doWork(): Promise<void>` is
  fine, but `function fire(): void { doWork(); }` drops the promise.

**Severity guidance:**
- Unhandled rejection that crashes: **critical**
- Missing `await` causing race condition: **warning**
- Sequential awaits that could parallelize: **suggestion**

## 3. Error Handling

**Look for:**
- **Empty catch blocks** — `catch (e) {}` silently swallows errors. At minimum,
  log the error.
- **Catching `unknown` without narrowing** — `catch (e)` gives `unknown` in
  strict mode. Must narrow: `if (e instanceof Error)` before accessing
  `.message` or `.stack`.
- **Missing error boundaries** — in frameworks like React, unhandled component
  errors crash the entire app. Add error boundaries around dynamic content.
- **Re-throwing without context** — `throw e` loses the catch-site context.
  Wrap with `new Error("context", { cause: e })` or use a custom error class.
- **Error type leaking** — internal error types (database errors, HTTP errors)
  leaking across module boundaries. Map to domain-specific errors at boundaries.

**Severity guidance:**
- Swallowed errors hiding failures: **critical**
- Missing error narrowing: **warning**
- Missing context on re-throw: **suggestion**

## 4. TypeScript-Specific Performance

**Look for:**
- **Barrel export re-exports** — `export * from "./module"` in `index.ts`
  prevents tree-shaking. Bundlers can't eliminate unused code from barrel files.
  Use direct imports.
- **Type-only imports mixed with value imports** — use `import type { T }` for
  types to ensure they're erased at compile time and don't create runtime
  dependencies.
- **Large union types** — unions with 50+ members cause slow type checking and
  IDE lag. Split into sub-unions or use branded types.
- **Recursive type depth** — deeply recursive types (`type Deep<T> = { nested: Deep<T> }`)
  hit TypeScript's depth limit (TS2589). Use explicit interfaces for recursive structures.
- **Runtime type checking with Zod in hot paths** — Zod validation is expensive.
  Validate at boundaries (API input, config load), not on every function call.

**Severity guidance:**
- Barrel exports preventing tree-shaking in library code: **warning**
- Missing `import type`: **suggestion**
- Recursive type causing TS2589: **warning**

## 5. TypeScript-Specific Testing

**Look for:**
- **Untyped mocks** — `vi.fn()` without type parameter produces
  `Mock<Procedure>`. Always type mocks: `vi.fn<(arg: T) => R>()`.
- **`as any` in tests** — test code using `as any` to bypass types means the
  test isn't verifying the real interface. Create proper fixtures that match
  the actual types.
- **Missing type-level tests** — for utility types and generic functions, add
  `expectTypeOf` assertions or `// @ts-expect-error` comments to verify type
  behavior.
- **Mock implementations diverging from real types** — mocks that don't match
  the actual interface pass tests but break at runtime.

**Severity guidance:**
- Untyped mocks hiding type errors: **warning**
- `as any` masking real issues: **suggestion**
- Missing type-level tests for utility types: **suggestion**

## 6. TypeScript Style & Conventions

**Look for:**
- **`enum` usage** — TypeScript enums have runtime cost and quirks (reverse
  mapping, numeric enums). Prefer `as const` objects with `typeof` for the
  union type:
  ```typescript
  // Prefer this
  const Status = { Active: "active", Inactive: "inactive" } as const;
  type Status = typeof Status[keyof typeof Status];
  ```
- **Namespace imports** — `import * as foo` prevents tree-shaking. Use named
  imports.
- **Implicit return types** — exported functions should have explicit return
  types for API stability. Internal functions can rely on inference.
- **Optional chaining overuse** — `a?.b?.c?.d?.e` chains suggest the data model
  is too loosely typed. Tighten the types instead of optional-chaining
  everywhere.
- **String literal unions vs branded types** — for domain identifiers (user IDs,
  order IDs), branded types prevent accidental mixing:
  ```typescript
  type UserId = string & { readonly __brand: "UserId" };
  type OrderId = string & { readonly __brand: "OrderId" };
  ```
- **Dead code from refactoring** — unused imports, unreachable branches after
  type changes, unused type definitions. TypeScript's `noUnusedLocals` and
  `noUnusedParameters` should be enabled.

**Severity guidance:**
- Enum in new code: **suggestion**
- Missing explicit return type on exported function: **suggestion**
- Dead imports/code: **nitpick**

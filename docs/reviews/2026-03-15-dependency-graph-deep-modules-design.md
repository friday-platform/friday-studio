# Review: dependency-graph (Move 1)

**Date:** 2026-03-15
**Branch:** dependency-graph
**Verdict:** Needs Work

## Summary

Phase 1 of the dependency graph redesign: sever all `@atlas/*` imports from
`@atlas/agent-sdk` to make it a true leaf node. Internalizes `stringifyError`,
`Logger`/`LogContext` interfaces, `ResourceToolkit`, and a minimal
`ArtifactOutputSchema`. Adds an architecture test enforcing the constraint.
Architecturally sound and cleanly traces to Move 1 of the plan — but typecheck
is broken, which blocks CI.

## Critical

### 1. `deno task typecheck` fails on architecture test

**Location:** `packages/agent-sdk/src/architecture.test.ts:42`
**Problem:** `JSON.parse` returns `unknown` under Deno's strict checking. The
test spreads `pkg.dependencies` and `pkg.devDependencies` without narrowing,
producing two TS18046 errors. `deno task typecheck` fails on this branch. vitest
masks this because it skips type checking at runtime.
**Recommendation:** Parse through a Zod schema (CLAUDE.md exempts `JSON.parse`
in test helpers before immediate Zod parse):

```typescript
const raw: unknown = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
const pkg = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
}).parse(raw);
const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
```

## Important

### 2. No tests for `extractArtifactRefsFromToolResults` after signature change

**Location:** `packages/agent-sdk/src/vercel-helpers/tool-usage.ts:53-86`
**Problem:** The function signature changed from a module-level logger import to
an optional `logger?: Logger` parameter, and the schema was swapped from
`ArtifactSchema` (12+ fields) to a minimal 3-field `ArtifactOutputSchema`. The
existing `tool-usage.test.ts` doesn't test this function at all — zero coverage
for the success path, error-result skip, parse-failure catch, or the
logger-absent code path.
**Worth doing: Yes** — this is the one behavioral change in the PR (signature +
schema swap). All current callers pass a real `Logger` from `AgentContext`, so
the undefined-logger path is only relevant for future external SDK consumers.
Still, ~20 lines covers all 3 branches and documents the contract.

### 3. `@opentelemetry/api` in dep tree but omitted from PR description

**Location:** `packages/agent-sdk/package.json:12`
**Problem:** PR description says "SDK dep tree is now: zod, ai, jsonrepair" but
`package.json` lists `@opentelemetry/api: ^1.9.0` as a runtime dependency. It's
only used as `import type { Tracer }` in `types.ts` — could be a
`peerDependency` or `devDependency` instead.
**Worth doing: Maybe** — if the goal is minimal footprint for external SDK
consumers, moving otel to `peerDependencies` is the right call. Low effort.
Either way, update the PR description.

## Tests

Architecture test is well-designed — two complementary assertions covering
source-level imports (regex with negative lookahead for self-refs) and
`package.json` declarations. Zero mocks, exercises real filesystem. Follows the
existing `web-client/architecture.test.ts` pattern.

Two gaps: (1) `extractArtifactRefsFromToolResults` has zero test coverage despite
a signature and schema change, (2) `stringifyError` has 4 branches with zero
tests (pre-existing gap — the original in `@atlas/utils` was also untested). The
`stringifyError` gap is not this PR's problem to solve.

Minor regex note: the import pattern catches `from` syntax but not dynamic
`import()` calls. Given the CLAUDE.md rule banning dynamic imports, this is
acceptable.

## Needs Decision

1. **`ResourceToolkit` return types widened to `Promise<unknown>`**: The old
   `Pick<ResourceStorageAdapter, ...>` preserved concrete return types. The new
   interface uses `Promise<unknown>` everywhere. All current callers serialize to
   JSON anyway — no loss today. If external SDK consumers ever need typed
   returns, minimal result interfaces can be added later. Acceptable trade-off?

2. **`@opentelemetry/api` as runtime vs peer dep**: It's only used for
   `import type { Tracer }`. Moving to `peerDependencies` keeps the install
   footprint minimal for external consumers who don't use telemetry. Worth doing
   now or defer?

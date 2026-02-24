# Review: move-src

**Date:** 2026-02-23
**Branch:** move-src
**Verdict:** Needs Work

## Summary

Mechanical refactor eliminating `src/` by distributing code to proper packages
and app directories. The moves are correct, types check, the config/storage
cycle is broken cleanly. Two build-breaking issues need fixing before merge; the
rest is documented technical debt the plan already scoped out.

## Critical

### 1. Build scripts reference deleted `src/utils/version.ts`

**Location:** `scripts/build-macos.sh:8`, `.github/actions/build-component/action.yml:85`

Both build scripts set `VERSION_FILE="src/utils/version.ts"` to sed-replace
`__ATLAS_VERSION__` and `__ATLAS_GIT_SHA__` placeholders at compile time. That
file moved to `packages/utils/src/version.ts`. CI builds will fail silently —
the sed targets a nonexistent file, so version strings ship as raw placeholders.

**Recommendation:** Update both to `VERSION_FILE="packages/utils/src/version.ts"`.

### 2. Missing `apps/atlas-cli/mod.ts` barrel file

**Location:** `apps/atlas-cli/deno.json`, `apps/atlas-cli/package.json`

Both declare `"exports": "./mod.ts"` but no `mod.ts` exists. Deno workspace
resolver will warn. Not a runtime crash (CLI is invoked directly via
`src/cli.tsx`), but it'll break any `import from "@atlas/cli"` and generates
noise in `deno check`.

**Recommendation:** Either create a minimal `mod.ts`, point exports at
`./src/cli.tsx`, or drop the exports field entirely since this is an app, not a
library.

## Important

### 3. Package→app inverted dependency (`@atlas/workspace` → `apps/atlasd`)

**Location:** `packages/workspace/src/runtime.ts:61-70`

Four imports reach from a package into an app directory via `../../../apps/atlasd/src/`.
This inverts the dependency graph (packages should not depend on apps). The plan
explicitly acknowledges this as accepted debt — flagging for the record.

The downstream effect: `runtime-session-summary.test.ts:26-28` uses
`vi.mock("../../../apps/atlasd/src/session-summarizer.ts")` — a cross-package
mock that silently breaks if the import path in `runtime.ts` changes. The mock
path changed from `./session-summarizer.ts` to the deep relative path as part of
this refactor, demonstrating the fragility.

**Recommendation:** No action needed for this PR. When revisiting, the cleanest
fix is injecting `generateSessionSummary` via `WorkspaceRuntimeOptions` (DI) —
the `createSessionStream` pattern already exists there. This eliminates both the
inverted dependency and the brittle mock.

### 4. Misleading comment in `atlasd/src/types/core.ts`

**Location:** `apps/atlasd/src/types/core.ts:157-159`

Comment says "IWorkspaceSession and IWorkspaceSignal are defined in @atlas/core"
but they're defined here and *re-exported* from @atlas/core. Direction is
backwards.

**Recommendation:** Flip to: "Defined here, re-exported from @atlas/core for use
by packages outside atlasd."

## Tests

4 of 5 test files are solid — pure renames or trivial import path updates with
excellent mock ratios (0-10%). The one weak spot is
`packages/workspace/src/runtime-session-summary.test.ts` with its cross-package
`vi.mock()` (see Important #3 above). This is a direct consequence of the
inverted dependency, not a test quality problem per se.

| Test File | Verdict | Mock Ratio | Risk |
|-----------|---------|------------|------|
| `atlasd/src/agent-helpers.test.ts` | Solid | 0% | None (pure rename) |
| `atlasd/src/session-summarizer.test.ts` | Solid | ~10% (DI seam) | None (pure rename) |
| `workspace/src/runtime.test.ts` | Solid | 0% | None |
| `workspace/src/runtime-fsm-events.test.ts` | Solid | 0% | Inherited dep graph |
| `workspace/src/runtime-session-summary.test.ts` | Weak | Cross-package mock | Brittle path |

## Needs Decision

1. **Build script paths** — straightforward fix, but verify the sed replacement
   still works against the new path (the file content is identical, so it
   should).

2. **atlas-cli exports field** — create `mod.ts`, point at `src/cli.tsx`, or
   drop exports? Depends on whether anything should be able to
   `import from "@atlas/cli"`.

3. **Inverted dependency timeline** — the plan scoped this out. Is that still the
   right call, or should the DI extraction happen in this PR while the context is
   hot?

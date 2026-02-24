# Eliminate src/ Directory

Shipped on `move-src` branch, 2026-02-23.

Moved all code from the monolithic `src/` directory into proper workspace
packages (`packages/@atlas/*`) and app directories (`apps/`). The `src/`
directory was a legacy artifact from when atlasd was the only app — it created
ambiguity about what was shared platform code vs. daemon internals. After this
refactor, `src/` no longer exists.

## What Changed

### apps/atlas-cli/ (new)

New app directory for the CLI. Received:

- `src/cli/` commands and `cli.tsx` entrypoint
- `src/services/` (daemon management, platform detection)
- `platform.ts`
- CLI-specific half of `version.ts` (dynamic version display)

### apps/atlasd/src/

Daemon internals that were incorrectly living in shared `src/`. Received:

- `src/core/` files (session management, FSM orchestration, workspace lifecycle)
  — everything except WorkspaceRuntime
- `metrics.ts` from `src/utils/`
- 19 of 21 types from `src/types/core.ts` (daemon-specific types like
  WorkspaceState, SessionState, etc.)

### packages/@atlas/workspace

- `workspace-runtime.ts` + tests moved here as-is (accepts 8 deps from atlasd —
  pragmatic choice over interface extraction)
- `id-generator.ts` moved here (was incorrectly scoped to src/)

### packages/@atlas/utils

- `fs.ts` and `release-channel.ts` from `src/utils/`
- Shared half of `version.ts` (version parsing, comparison)

### packages/@atlas/logger

- `telemetry.ts` moved from `src/utils/` (was incorrectly targeted at atlasd in
  v1 — @atlas/mcp depends on it, so it must live in a package)

### packages/@atlas/signals

- `providers/` directory moved from `src/`
- Diverged `types.ts` merged with existing package types

### packages/@atlas/core

- 2 shared types from `src/types/core.ts` (SessionSummary renamed to avoid
  collision with existing core type)

### packages/@atlas/config

- Broke `@atlas/config ↔ @atlas/storage` type-only import cycle by extracting
  shared type interfaces

## Key Decisions

**WorkspaceRuntime moved to @atlas/workspace as-is, no interface extraction.**
v2–v4 planned extracting an `IWorkspaceRuntime` interface to avoid pulling 8
atlasd deps into workspace. v5 dropped this — the deps are already workspace
concepts, and interface extraction would be code authoring in a mechanical
refactor. Accept the dep bloat, clean up later if needed.

**src/types/core.ts split selectively, not bulk-merged.** Only 2 of 21 types
went to @atlas/core. The rest are daemon internals (WorkspaceState,
SessionState, etc.) that belong in atlasd. Bulk merge would have caused a
SessionSummary naming collision with the existing @atlas/core type.

**Single-phase execution, not phased.** Earlier versions planned 3 phases
(packages first, atlasd second, CLI third). v5 collapsed to single phase —
phasing adds coordination overhead for what's fundamentally a mechanical
operation.

**telemetry.ts goes to @atlas/logger, not atlasd.** @atlas/mcp imports
telemetry, so it can't live in an app directory. Logger is the natural home.

**id-generator.ts goes to @atlas/workspace, not atlasd.** @atlas/workspace
imports it, so same constraint as telemetry — must live in a package.

## Out of Scope

- **WorkspaceRuntime dep cleanup** — it pulls 8 deps from atlasd into
  @atlas/workspace. Acceptable for now, worth revisiting if workspace becomes a
  leaner package.
- **Further type splitting** — the 19 atlasd types could be further organized
  into sub-modules. Not worth doing until the types themselves need changes.
- **Barrel file cleanup** — some packages gained re-exports to maintain
  backwards compatibility. Can trim as consumers update.

## Test Coverage

All existing tests moved with their source files. WorkspaceRuntime tests moved
to @atlas/workspace. No new tests added — this is a mechanical refactor with
zero behavior changes.

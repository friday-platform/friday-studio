# Workspace Bundles — Implementation Plan

**Date:** 2026-04-20
**Companion to:** `2026-04-14-workspace-bundles-design.md`,
`2026-04-20-workspace-bundles-export-research.md`
**Purpose:** Concrete, PR-sized task list adapted to declaw surfaces.
Three phases: A (shape), B (state), C (refinement).

## Phase A — Shape proof (definition-only bundles)

Hero demo: `atlas bundle export` on
`workspaces/fast-improvements-source/` → zip → import into a fresh space
dir → fire `run-task` signal → architect → coder → reviewer pipeline
runs identically.

### A1. New package `@atlas/bundle`

- `packages/bundle/` — new Deno package. Deps: `@atlas/agent-sdk`,
  `@atlas/logger`, `jszip`-equivalent for zip I/O, `zod`.
- Exports: `Hasher`, `Lockfile`, `WorkspaceLoader`, `Bundle`. One module
  per concern (design-doc module boundaries).
- `deno.json` + `package.json` set up; vitest wired.

### A2. Hasher module

- `src/hasher.ts` — `hashPrimitive(dir: string): Promise<HashResult>`
  returning `{ hash, manifest, files }`.
- Manifest format per design: sorted paths, LF-normalized per-file
  sha256, combined sha256.
- Exclusions: `.DS_Store`, `.git/`, `*.tmp`, `.atlas-ignore` glob.
- Tests (`hasher.test.ts`): property-style — reorder files → same hash;
  byte change → different hash; CRLF parity; excluded-files parity.

### A3. Lockfile module

- `src/lockfile.ts` — Zod schema for the v1 lockfile shape (design doc
  "Lockfile schema (v1)" block).
- `readLockfile(path)` / `writeLockfile(path, obj)` with stable
  field ordering.
- Tests: round-trip stability; invalid shape rejection with precise
  errors; `mode: definition` with `snapshots:` present is rejected.

### A4. Migrate `fast-improvements-source` skill layout

- `git mv workspaces/fast-improvements-source/skill
  workspaces/fast-improvements-source/skills/parity-plan-context`.
- Update `workspace.yml`'s `skills: ['@tempest/parity-plan-context']`
  reference (no change — already name-based).
- Verify the existing `SkillAdapter`'s skill discovery still picks it
  up from the new path. Land in the same PR as A5 so loader + on-disk
  layout change together.

### A5. Workspace loader module

- `src/loader.ts` — `loadWorkspace(dir): Promise<LoadedWorkspace>`.
- Reads `workspace.yml` via existing `packages/config/` schemas; reads
  `workspace.lock`; walks `skills/<name>/` and `agents/<name>/` trees.
- Cross-check: every primitive declared in `workspace.yml` has a pin
  in `workspace.lock` and a corresponding directory on disk with
  matching hash.
- Inline primitives in `workspace.yml` continue to load (backward
  compat during transition).

### A6. Bundle module — export (definition-only)

- `src/bundle.ts` — `exportBundle({ workspaceId, mode: "definition",
  outPath })`.
- Inside the existing `apps/atlasd/routes/workspaces/index.ts` export
  handler (line ~829 is the template):
  1. Load workspace config via `WorkspaceManager.getWorkspaceConfig()`
     — reuse verbatim.
  2. Reuse `injectBundledAgentRefs()` from `packages/config/src/
     mutations/credentials.ts` to inject refs for bundled agents.
  3. Reuse `extractCredentials`, `toProviderRefs`,
     `stripCredentialRefs` — identical semantics to today's YAML export.
  4. Emit the bundle directory tree in a staging dir:
     - `workspace.yml` (composed, with provider refs, no `workspace.id`)
     - `skills/<name>/…` copied from workspace dir
     - `agents/<name>/…` copied
     - `resources/<slug>/schema.yml` from ledger (existing path)
  5. Compute Hasher output for each primitive; write `workspace.lock`
     with `mode: definition`, primitive hashes, platform deps.
  6. Zip the staging dir; return bytes.

### A7. Bundle endpoint

- New route in `apps/atlasd/routes/workspaces/index.ts`:
  `GET /:workspaceId/bundle?mode=definition` → `application/zip`
  with `Content-Disposition: attachment; filename="<name>.zip"`.
- Leave `GET /:workspaceId/export` unchanged (compatibility).
- Response body includes a short JSON header with the creds report —
  or, since this is a zip, emit the creds report on a side header
  (`X-Creds-Needed: base64(json)`) to avoid contaminating the zip.
  (Simpler alt: `POST /bundle/preview` returns the creds JSON before
  the consumer downloads the zip. Decide during implementation.)

### A8. Bundle module — import (definition-only)

- `src/bundle.ts` — `importBundle({ zipBytes, targetDir }):
  Promise<ImportReport>`.
- Steps:
  1. Unzip to a staging dir.
  2. Read `workspace.lock`; verify every primitive hash against
     on-disk content; fail atomically on mismatch.
  3. Check platform deps against the receiving daemon; fail with a
     structured error on mismatch.
  4. Move staging dir → `targetDir` (atomic rename).
  5. Register the workspace via `WorkspaceManager.create()`.
  6. Return `{ workspaceId, credsNeeded: [...], primitives: [...] }`.
- Tests (`bundle.test.ts`): round-trip with
  `fast-improvements-source`; tampered zip rejected cleanly;
  incompatible platform deps rejected cleanly.

### A9. Import endpoint

- `POST /api/workspaces/import-bundle` accepting `multipart/form-data`
  (zip file).
- Returns the `ImportReport` JSON.
- Consumer then hits existing
  `POST /workspaces/:id/credentials/import` for each entry in
  `credsNeeded`.

### A10. CLI wrappers

- `apps/atlas-cli/` — `atlas bundle export <workspace-id> --out <zip>`
  and `atlas bundle import <zip> --target <dir>`. Thin wrappers over
  the HTTP endpoints.

### A11. End-to-end smoke test

- `apps/atlasd/routes/workspaces/bundle.test.ts` — integration test:
  1. Start with `fast-improvements-source` in a tmp workspace dir.
  2. Export as definition-only bundle.
  3. Import into a fresh tmp dir.
  4. Fire `run-task` signal against the imported space.
  5. Assert the FSM transitions through step_research → step_implement
     → step_review to completion.

**Phase A exit criterion:** The smoke test above passes end-to-end on
a fresh daemon, and `workspaces/fast-improvements-source/` boots from
the new `skills/<name>/` layout without behavior change.

## Phase B — State proof (migration-mode bundles)

Hero demo: add narrative entries via the `md-narrative` memory adapter
on `fast-improvements-source` → export `--with-state` → import on a
fresh workspace dir → memory is readable on the target.

### B1. `Snapshottable` interface in `@atlas/agent-sdk`

- `packages/agent-sdk/src/snapshottable.ts` — new interface file per
  the design-doc signature.
- Export from `mod.ts`.

### B2. Implement on `md-narrative`

- `packages/adapters-md/src/md-narrative-corpus.ts`:
  - `readonly backendId = "md-narrative"`.
  - `exportSnapshot()`: tar the backing directory (including
    `memory.md` + any aux files) into `Uint8Array`.
  - `importSnapshot(bytes)`: untar into the backing directory; replace
    existing content atomically (stage + rename).
- Tests: round-trip of a corpus with 3 entries; tar format stable; tar
  of empty corpus produces a deterministic byte sequence.

### B3. Implement on `sqlite-kv`, `sqlite-dedup`, `sqlite-rag`

- Three corpora in `packages/agent-sdk/src/backends/*`.
- `exportSnapshot()`: close transactions, copy the `.db` file bytes,
  return as `Uint8Array`. SQLite's `.backup` / VACUUM INTO pattern may
  be cleaner — pick during implementation.
- `importSnapshot(bytes)`: write bytes to `.db` path atomically
  (staged path + rename), re-initialize connection.
- Tests: round-trip of a small set of entries per backend.

### B4. Lockfile schema extension

- Extend Zod schema for `snapshots:` section (design doc v1 shape).
- Versioning: still `schemaVersion: 1` (additive fields allowed;
  breaking changes bump to 2).
- Tests: lockfile with `mode: migration` and missing `snapshots:` is
  rejected; definition-mode with `snapshots:` present is rejected.

### B5. Bundle export — migration mode

- Extend `exportBundle` to accept `mode: "migration"`.
- Walks `MemoryAdapter.listCorpora(workspaceId)`; for each corpus,
  calls `exportSnapshot()`, writes bytes to
  `memory/<corpus>/snapshot.bin`, records `{backend, digest}` in the
  lockfile.
- Does the same for resource data via existing ledger export (new
  NDJSON path — coordinate with `provisionConfigResources`).
- History remains a stub for Phase B; surface the flag but write an
  empty `history/` dir.

### B6. Bundle import — migration mode

- On import in migration mode:
  1. After primitive verification, read each snapshot entry.
  2. Verify the receiving daemon has a backend registered for the
     pinned `backend` id; fail clean on missing.
  3. Verify digest of the snapshot bytes.
  4. Resolve the adapter for the matching corpus on the target
     workspace (MemoryAdapter factory).
  5. Call `adapter.importSnapshot(bytes)`.
- Atomic: if any snapshot fails, roll back the entire import (delete
  target dir, unregister workspace).

### B7. Migration-mode smoke test

- Extend `bundle.test.ts`:
  1. Seed `fast-improvements-source` with narrative entries in
     `dispatch-log` and `autopilot-backlog`.
  2. Export `--with-state`.
  3. Import into a fresh dir.
  4. Assert target workspace's narrative corpora contain the same
     entries.

**Phase B exit criterion:** Hero demo passes; at least one md corpus
and one sqlite corpus round-trip byte-identical state through a bundle.

## Phase C — Refinement (post-POC)

Ordered roughly by user value; each item a separate PR.

- **C1.** Resource data export (ledger document contents as NDJSON).
  Required for any space that stores data in Atlas resources.
- **C2.** Model configs + communicators in bundle. Currently inline in
  `workspace.yml`; verify nothing leaks machine-specific state.
- **C3.** External skill materialization at export. If any skill is
  referenced from a remote URL, resolve and inline it at export time.
- **C4.** Metadata schema enforcement (author, tags, license SPDX
  shape). Zod at the manifest boundary.
- **C5.** Version-bump gate on `atlas bundle`. Small local state file
  tracks the last published workspace version.
- **C6.** History export (`--with-history`): chat transcripts, job
  runs, activity ledger.
- **C7.** Inline → file-based primitive transition tooling (`atlas
  bundle migrate-inline`). Optional — bundles still work for spaces
  that stay inline during transition.
- **C8.** Publish-time primitive rename with namespace auto-suggest
  (v1 skips this; bundles produced from imported bundles inherit
  upstream labels).

## Open decisions during implementation

- **Where `@atlas/bundle` lives.** Standalone package vs. sub-module
  of `@atlas/workspace`. Standalone is cleaner for testability but
  adds a new package. Lean: standalone.
- **Creds report delivery.** Separate preview endpoint, side header,
  or post-import JSON on a follow-up GET. Lean: post-import JSON body
  from `/import-bundle` response.
- **Atomic staging location.** Staging inside target dir (`.staging/`)
  vs. system tmp. System tmp cross-filesystem rename can be slow;
  staging in-place avoids that but clutters the target.
- **Workspace.lock committable to git.** Default to committing (like
  `deno.lock`). Verify `.gitignore` patterns don't accidentally
  exclude it.
- **Bundle file extension.** `.zip` or a branded `.atlas`/`.friday`
  extension. Lean: `.zip` for tooling compatibility; optionally a
  `.friday` symlink if branding matters.

## Not in this plan (deferred)

- Primitive cache (`~/.atlas/primitives/`): v2 optimization, design-
  doc out-of-scope.
- FridayHub registry integration: explicitly deferred by parity plan.
- Cryptographic bundle signing: hashes only.
- Multi-user machine isolation for any future cache.

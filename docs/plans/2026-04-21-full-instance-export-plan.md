# Full-instance export/import — plan for global state

Status: Phases 1, 2, 3 shipped 2026-04-21. Phase 4 (credentials) still a plan.

## Shipped now (phase 1)

- `GET /api/workspaces/bundle-all[?mode=definition|migration]` — zip-of-zips containing one regular per-workspace bundle per entry.
- `POST /api/workspaces/import-bundle-all` — multipart with field `bundle`; iterates inner bundles through the existing `importBundle` path and registers each via `WorkspaceManager`.
- Virtual workspaces (no on-disk dir — kernel `system` etc.) are skipped with `X-Atlas-Skipped-Workspaces` header and a manifest omission.
- Outer archive layout:
  ```
  atlas-full-export-YYYY-MM-DD.zip
  ├── manifest.yml                 # FullManifest — schemaVersion, entries, reserved.global
  └── workspaces/
      ├── <source-workspace-id>.zip
      └── ...
  ```
- No collision detection on import — each inner bundle gets a fresh auto-generated workspace ID, matching `/import-bundle` behavior. Same-name workspaces are expected and fine.

## Reserved slots (populated in later phases)

`manifest.yml.reserved.global` already has `skills: null` and `memory: null` placeholders. Readers must tolerate unknown or non-null values for forward-compat. When a later phase populates them, the manifest just flips null → path, and the outer archive gains a sibling `global/` dir.

## Phase 2 — global skills (shipped 2026-04-21)

**Landed**: global skills live in `~/.atlas/skills.db` (a SQLite file, not a directory — confirmed via `packages/skills/src/local-adapter.ts:60`).

- `packages/bundle/src/global-skills.ts` — `exportGlobalSkills({ skillsDbPath })` produces a zip with the raw SQLite file + a lightweight manifest carrying the sha256. `importGlobalSkills({ zipBytes, skillsDbPath })` verifies the digest and writes. **Non-destructive**: if a skills.db already exists at the target, the imported one is sideloaded to `skills.db.imported-<ts>` for manual merge. No automatic row-level merger.
- `exportAll` gained `global.skills?: Uint8Array`; `importAll` returns `globalSkillsBytes?: Uint8Array`. Manifest's `reserved.global.skills` flips from `null` to `"global/skills.zip"` when present.
- `GET /api/workspaces/bundle-all?include=global-skills` — opt-in. Default stays workspaces-only. Response header `X-Atlas-Global-Skills: included|missing-source-db|not-requested`.
- `POST /api/workspaces/import-bundle-all` — auto-imports global skills if the archive contains them; response body reports `globalSkills: { kind: "imported" | "skipped-existing" | "integrity-failed", ... }`.

**Known limitation**: row-level merge is a future follow-up. A user with a populated target skills.db won't see their archive's skills applied (they'll see the sideloaded file instead).

## Phase 3 — memory state (shipped 2026-04-21)

**Landed with option 2 from the original sketch** — memory embedded in per-workspace bundles, not in `global/`. Keeps memory ownership with its workspace and avoids the source-wid → new-wid remap problem.

- `ExportOptions.memoryDir?: string` — optional path to `~/.atlas/memory/<wid>/`. Honored only in `mode: migration`. Files go into the bundle under `memory/<narrative-name>/...` with a hash per narrative recorded in the existing `snapshots.memory` slot of the lockfile.
- `ImportResult.primitives` widened to include `{ kind: "memory", name, path }` entries.
- After `importBundle`, per-narrative memory lives at `<targetDir>/memory/<name>/...`. The route layer then moves the tree to `<atlasHome>/memory/<new-wid>/narrative/` via the new `materializeImportedMemory` helper. Non-destructive: if a target memory dir already exists, the imported tree sideloads to `<atlasHome>/memory/<new-wid>.imported-<ts>/`.
- Every bundle route (per-workspace and bundle-all) passes `memoryDir` in migration mode and materializes after register on the import side.

**Export behavior recap**:
- `GET /api/workspaces/<id>/bundle?mode=migration` — includes that workspace's memory tree.
- `GET /api/workspaces/bundle-all?mode=migration` — includes each workspace's memory tree.
- `mode=definition` (default) — no memory in the bundle.

## Phase 4 — credentials + link state

Later. Requires key management (encrypted-at-rest in the bundle, passphrase on import). Out of scope for this plan.

## Compatibility contract

- `manifest.FullManifestSchema` uses `.passthrough()` on `reserved.global` — old readers tolerate new keys.
- Bumping `schemaVersion` is reserved for actual breaking changes. Adding new optional top-level sections should stay at schemaVersion 1.
- Inner per-workspace bundle format stays untouched by all of the above — `exportBundle`/`importBundle` remain the canonical unit of portability.

## Open questions

1. Where are user-installed global skills actually stored today? Need to trace `skills.sh` and daemon's skill scan.
2. Should we add a `POST /api/admin/bundle-all` variant that requires a token, for automation / periodic-export-to-object-storage?
3. Export determinism — currently `manifest.createdAt` makes the output non-deterministic. Fine for humans, annoying for CI. Add a `?deterministic=true` flag that zeros the timestamp?
